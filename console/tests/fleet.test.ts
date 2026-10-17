import { describe, it, expect, vi, afterEach } from "vitest";
import {
  FleetMonitor,
  sampleValues,
  UpstreamError,
  type Transport,
} from "../src/fleet.ts";
import { Store } from "../src/store.ts";
import { config, makeSnapshot } from "./fixtures.ts";
const stores: Store[] = [];
afterEach(() => {
  stores.splice(0).forEach((s) => {
    s.close();
  });
  vi.useRealTimers();
});
function setup(transport: Transport) {
  const store = new Store(":memory:");
  stores.push(store);
  return new FleetMonitor(config, store, transport);
}
describe("fleet collection", () => {
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
    await m.pollHost("yd-mini");
    expect(transport).toHaveBeenCalledTimes(1);
    resolve(makeSnapshot());
    await first;
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
    m.stop();
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
