import { describe, it, expect } from "vitest";
import {
  alertsFor,
  dataDisk,
  displayName,
  formatBytes,
  formatNumber,
  isVirtual,
  nodeKindLabel,
  nodeIdentityLabel,
  memoryPct,
  orderedPoints,
  stale,
  storageClasses,
  uptime,
  metricValue,
} from "../src/domain.ts";
import { makeHost } from "./fixtures.ts";
import { SnapshotSchema } from "../src/contracts.ts";
describe("node interpretation", () => {
  it("prefers the recorded identity and falls back to the declared type", () => {
    const h = makeHost(2);
    expect(nodeIdentityLabel(h)).toBe("Tart on M4 Max MacBook");
    h.identity = " ";
    h.snapshot = null;
    expect(nodeIdentityLabel(h)).toBe("虚拟机");
    h.kind = "physical";
    expect(nodeIdentityLabel(h)).toBe("物理机");
  });
  it("uses the declared type independently of hardware readings or identity wording", () => {
    const h = makeHost(2);
    h.snapshot = null;
    expect(isVirtual(h)).toBe(true);
    expect(nodeKindLabel(h)).toBe("虚拟机");
    h.kind = "physical";
    expect(nodeKindLabel(h)).toBe("物理机");
    expect(isVirtual(h)).toBe(false);
  });
  it("normalizes display names without rewriting host identities", () => {
    const h = makeHost();
    if (h.snapshot?.host) h.snapshot.host.name = "yd-mini.lan";
    expect(displayName(h)).toBe("yd-mini");
    expect(h.name).toBe("yd-mini");
    expect(isVirtual(makeHost(2))).toBe(true);
    expect(memoryPct(h)).toBeCloseTo(32.5);
    expect(dataDisk(h)?.fs).toBe("APFS");
  });
  it("marks stale data and treats missing data as unknown", () => {
    const h = makeHost();
    expect(stale(h, h.lastTs + 10001)).toBe(true);
    h.snapshot = null;
    expect(memoryPct(h)).toBeNull();
    expect(dataDisk(h)).toBeUndefined();
    expect(displayName(h)).toBe(h.name);
    expect(isVirtual(h)).toBe(false);
  });
  it("reports actionable capacity, thermal and CPU issues without flagging normal memory cache", () => {
    const h = makeHost();
    expect(alertsFor([h], Date.now())).toEqual([]);
    if (!h.snapshot?.sys) throw Error("fixture");
    if (!h.snapshot.sys.disks[0]) throw Error("fixture");
    h.snapshot.sys.disks[0].available_bytes = 20 * 2 ** 30;
    h.snapshot.sys.cpu.usage_pct = 95;
    h.snapshot.sys.mem.available_bytes = 0.5 * 2 ** 30;
    h.snapshot.thermal = { state: 3, ts: Date.now() };
    expect(alertsFor([h], Date.now())).toHaveLength(4);
    h.online = false;
    expect(alertsFor([h], Date.now())).toHaveLength(1);
  });
  it("rejects malformed agent payloads at the shared boundary", () => {
    expect(
      SnapshotSchema.safeParse({ sys: { cpu: { usage_pct: "100" } } }).success,
    ).toBe(false);
  });
});
describe("storage and history math", () => {
  it("does not count parent and children twice", () => {
    const s = makeHost().snapshot?.disk_scans[0];
    if (!s) throw Error("fixture");
    expect([...storageClasses(s).values()].reduce((a, b) => a + b, 0)).toBe(
      s.bytes,
    );
    expect(storageClasses(s).get("apps")).toBe(2 * 2 ** 30);
  });
  it("bounds inconsistent child totals to the parent budget", () => {
    const s = makeHost().snapshot?.disk_scans[0];
    if (!s) throw Error("fixture");
    s.bytes = 1;
    expect(
      [...storageClasses(s).values()].reduce((a, b) => a + b, 0),
    ).toBeCloseTo(1);
  });
  it("orders and deduplicates timestamps without losing the latest point", () => {
    expect(
      orderedPoints([
        { ts: 2, value: 3 },
        { ts: 1, value: 2 },
        { ts: 2, value: 9 },
        { ts: NaN, value: 5 },
      ]),
    ).toEqual([
      { ts: 1, value: 2 },
      { ts: 2, value: 9 },
    ]);
  });
  it("formats zero, missing, binary units and long uptimes accurately", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(2 ** 30)).toBe("1.0 GiB");
    expect(formatBytes(1024)).toBe("1.0 KiB");
    expect(formatBytes(2 ** 40)).toBe("1.0 TiB");
    expect(formatNumber(NaN)).toBe("—");
    expect(uptime(90000)).toBe("1 天 1 小时");
    expect(uptime(3601)).toBe("1 小时 0 分钟");
    expect(uptime(0)).toBe("0 分钟");
    expect(uptime(undefined)).toBe("—");
    expect(metricValue(1, "W")).toBe("1.0 W");
    expect(metricValue(2 ** 30, "B")).toBe("1.0 GiB");
  });
});
