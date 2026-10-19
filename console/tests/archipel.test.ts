import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ArchipelMonitor,
  sampleValues,
  UpstreamError,
  type Transport,
} from "../src/archipel.ts";
import { Store } from "../src/store.ts";
import { config, makeSnapshot } from "./fixtures.ts";
const stores: Store[] = [];
const monitors: ArchipelMonitor[] = [];
afterEach(async () => {
  await Promise.all(monitors.splice(0).map((m) => m.stop()));
  await Promise.all(stores.splice(0).map((s) => s.close()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function setup(transport: Transport) {
  const store = new Store(":memory:");
  stores.push(store);
  const monitor = new ArchipelMonitor(config, store, transport);
  monitors.push(monitor);
  return monitor;
}
describe("archipel collection", () => {
  it("restores exact source watermarks rather than deduplicating against chart buckets", async () => {
    const snapshot = makeSnapshot();
    if (!snapshot.sys) throw Error("fixture");
    snapshot.sys.ts = Math.floor(Date.now() / 1000) * 1000 + 123;
    const store = new Store(":memory:");
    stores.push(store);
    await store.insertSamples([
      { host: "yd-mini", key: "cpu.usage_pct", ts: snapshot.sys.ts, value: 20 },
    ]);
    const insert = vi.spyOn(store, "insertSamples");
    const m = new ArchipelMonitor(config, store, () =>
      Promise.resolve(snapshot),
    );
    monitors.push(m);
    m.start();
    await m.pollHost("yd-mini");
    await m.stop();
    expect(
      insert.mock.calls
        .flatMap(([rows]) => rows)
        .filter((row) => row.host === "yd-mini" && row.key === "cpu.usage_pct"),
    ).toEqual([]);
  });
  it("rejects expired and failed collector readings while the node remains reachable", async () => {
    const snapshot = makeSnapshot();
    if (!snapshot.sys || !snapshot.macmon || !snapshot.fan)
      throw Error("fixture");
    snapshot.sys.ts -= 60_000;
    snapshot.macmon.error = true;
    snapshot.fan.ts = Date.now() + 60_000;
    const m = setup(() => Promise.resolve(snapshot));
    await m.poll();
    const host = m.state().hosts[0];
    expect(host?.online).toBe(true);
    for (const key of ["cpu.usage_pct", "gpu.usage_pct", "fan.rpm"])
      expect(host?.history[key]).toEqual([]);
    expect(host?.history["thermal.state"]).toHaveLength(1);
  });
  it("bounds failed writes, reports loss and drains the retained batch on recovery", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    const insert = vi
      .spyOn(store, "insertSamples")
      .mockRejectedValue(new Error("disk full"));
    let time = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => time++);
    const m = new ArchipelMonitor(config, store, () =>
      Promise.resolve(makeSnapshot()),
    );
    monitors.push(m);
    for (let i = 0; i < 400; i++) await m.pollHost("yd-mini");
    expect(m.state().historyDropped).toBeGreaterThan(0);
    await m.poll();
    expect(m.state().hosts.every((host) => host.online)).toBe(true);
    insert.mockRestore();
    await m.stop();
    expect(
      await store.queryRange("yd-mini", "cpu.usage_pct", 0, time),
    ).not.toEqual([]);
    expect(m.state().historyError).toBe("历史缓冲已满，部分样本未保存");
    vi.restoreAllMocks();
  });
  it("aborts and drains in-flight polls before stopping without publishing late data", async () => {
    let release!: () => void;
    const transport: Transport = (_url, _token, _body, _method, signal) =>
      new Promise((resolve) => {
        release = () => {
          resolve(makeSnapshot());
        };
        signal?.addEventListener("abort", release, { once: true });
      });
    const m = setup(transport);
    const pending = m.pollHost("yd-mini");
    await m.stop();
    await pending;
    expect(m.state().hosts[0]?.snapshot).toBeNull();
    await m.pollHost("yd-mini");
    expect(m.state().hosts[0]?.snapshot).toBeNull();
  });
  it("does not invent fresh samples when a collector stops", async () => {
    const snapshot = makeSnapshot();
    const m = setup(() => Promise.resolve(snapshot));
    await m.pollHost("yd-mini");
    await m.pollHost("yd-mini");
    expect(m.state().hosts[0]?.history["cpu.usage_pct"]).toEqual([
      { ts: snapshot.sys?.ts, value: snapshot.sys?.cpu.usage_pct },
    ]);
  });
  it("keeps reachable nodes online when history persistence fails", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    vi.spyOn(store, "insertSamples").mockImplementation(() => {
      throw new Error("disk full");
    });
    const m = new ArchipelMonitor(config, store, () =>
      Promise.resolve(makeSnapshot()),
    );
    monitors.push(m);
    await m.poll();
    expect(m.state().hosts.every((h) => h.online)).toBe(true);
    expect(m.state().hosts[0]?.lastError).toBeNull();
    expect(m.state()).toHaveProperty("historyError");
  });
  it("keeps configured types and identities before collection and while offline", async () => {
    const m = setup(() => Promise.reject(new UpstreamError(502, "节点超时")));
    const metadata = () =>
      m
        .state()
        .hosts.map(({ name, kind, identity }) => ({ name, kind, identity }));
    const expected = config.hosts.map(({ name, kind, identity }) => ({
      name,
      kind,
      identity,
    }));
    expect(metadata()).toEqual(expected);
    await m.poll();
    expect(metadata()).toEqual(expected);
  });
  it("validates payloads, retains last good data and exposes sanitized errors", async () => {
    let bad = false;
    const m = setup(() =>
      bad
        ? Promise.reject(new UpstreamError(502, "节点超时"))
        : Promise.resolve(makeSnapshot()),
    );
    await m.poll();
    expect(m.state().hosts.every((h) => h.online)).toBe(true);
    bad = true;
    await m.poll();
    expect(m.state().hosts[0]?.online).toBe(false);
    expect(m.state().hosts[0]?.snapshot).not.toBeNull();
    expect(m.state().hosts[0]?.lastError).toBe("节点超时");
  });
  it("rejects invalid payloads instead of publishing untyped data", async () => {
    const m = setup(() => Promise.resolve({ sys: "broken" }));
    await m.poll();
    expect(m.state().hosts[0]?.lastError).toBe("节点数据校验失败");
  });
  it("prevents overlapping slow polls", async () => {
    let resolve!: (value: unknown) => void;
    const transport = vi.fn<Transport>(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      ),
      m = setup(transport);
    const first = m.pollHost("yd-mini");
    const second = m.pollHost("yd-mini");
    expect(transport).toHaveBeenCalledTimes(1);
    resolve(makeSnapshot());
    await Promise.all([first, second]);
  });
  it("preserves unknown plugin payloads and isolates invalid plugin data from core monitoring", async () => {
    const snapshot = makeSnapshot();
    snapshot.plugins = {
      arbitrary: { version: 900, custom: { nested: [1, "opaque", null] } },
      malformed: "broken",
    };
    const m = setup(() => Promise.resolve(snapshot));
    await m.poll();
    expect(m.state().hosts[0]?.online).toBe(true);
    expect(m.state().hosts[0]?.snapshot?.plugins).toEqual(snapshot.plugins);
    expect(m.state()).not.toHaveProperty("github");
  });
  it("captures measured power rather than plotting frequency under the power label", () => {
    const values = new Map(sampleValues(makeSnapshot()));
    expect(values.get("power.package_w")).toBe(6.2);
    expect(values.get("cpu.p_freq_mhz")).toBe(1440);
    expect(new Map(sampleValues(makeSnapshot(2))).has("fan.rpm")).toBe(false);
  });
  it("keeps missing temperatures missing and bounds live history payload", async () => {
    const s = makeSnapshot();
    if (s.fan) s.fan.have_temp = false;
    expect(new Map(sampleValues(s)).has("fan.temp_c")).toBe(false);
    const m = setup(() => Promise.resolve(s));
    vi.useFakeTimers();
    for (let i = 0; i < 650; i++) {
      vi.setSystemTime(Date.now() + 1000);
      await m.pollHost("yd-mini");
    }
    expect(
      m.state().hosts[0]?.history["cpu.usage_pct"]?.length,
    ).toBeLessThanOrEqual(121);
    m.start();
    await m.stop();
    await Promise.resolve();
  });
  it("rejects unknown command targets", async () => {
    const m = setup(() => Promise.resolve({ ok: true }));
    await expect(m.command("unknown", "rescan-disk", {})).rejects.toThrow(
      "节点不存在",
    );
    await m.pollHost("unknown");
  });
});
