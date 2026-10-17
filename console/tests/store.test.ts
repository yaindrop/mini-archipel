import { afterEach, describe, it, expect } from "vitest";
import { Store } from "../src/store.ts";
let store: Store;
afterEach(() => {
  store.close();
});
describe("bounded multiresolution history", () => {
  it("reads recent, mid and coarse samples together and sorts them", () => {
    store = new Store(":memory:");
    const now = Date.now(),
      day = 86400_000;
    store.insertSamples([
      { host: "a", key: "cpu", ts: now - 40 * day, value: 10 },
      { host: "a", key: "cpu", ts: now - 3 * day, value: 20 },
      { host: "a", key: "cpu", ts: now - 1000, value: 30 },
      { host: "b", key: "cpu", ts: now - 1000, value: 999 },
    ]);
    store.downsampleAndPrune(now);
    const points = store.queryRange("a", "cpu", now - 60 * day, now);
    expect(points.map((p) => p.value)).toEqual([10, 20, 30]);
    expect(points.map((p) => p.ts)).toEqual(
      points.map((p) => p.ts).toSorted((a, b) => a - b),
    );
  });
  it("prunes beyond a year and is safe to run repeatedly", () => {
    store = new Store(":memory:");
    const now = Date.now();
    store.insertSamples([
      { host: "a", key: "cpu", ts: now - 370 * 86400_000, value: 100 },
    ]);
    store.downsampleAndPrune(now);
    store.downsampleAndPrune(now);
    expect(store.queryRange("a", "cpu", 0, now)).toEqual([]);
  });
  it("waits for complete buckets before pruning raw or mid samples", () => {
    store = new Store(":memory:");
    const base = 1_800_000_000_000,
      day = 86_400_000;
    store.insertSamples(
      Array.from({ length: 10 }, (_, i) => ({
        host: "a",
        key: "cpu",
        ts: base + i * 1000,
        value: i * 10,
      })),
    );
    store.downsampleAndPrune(base + day + 5000);
    store.downsampleAndPrune(base + day + 15_000);
    expect(
      store.queryRange("a", "cpu", base, base + 10_000).map((p) => p.value),
    ).toEqual([45]);
    store.insertSamples(
      Array.from({ length: 6 }, (_, i) => ({
        host: "b",
        key: "cpu",
        ts: base + i * 10_000,
        value: i * 10,
      })),
    );
    store.downsampleAndPrune(base + 30 * day + 25_000);
    store.downsampleAndPrune(base + 30 * day + 65_000);
    expect(
      store.queryRange("b", "cpu", base, base + 60_000).map((p) => p.value),
    ).toEqual([25]);
  });
  it("bounds large ranges to at most 1201 ordered buckets", () => {
    store = new Store(":memory:");
    const now = Date.now();
    store.insertSamples(
      Array.from({ length: 6000 }, (_, i) => ({
        host: "a",
        key: "cpu",
        ts: now - i * 1000,
        value: i % 100,
      })),
    );
    const points = store.queryRange("a", "cpu", now - 6000_000, now);
    expect(points.length).toBeLessThanOrEqual(1201);
    expect(points.length).toBeGreaterThan(1000);
    expect(store.queryRange("a", "missing", 0, now)).toEqual([]);
    store.insertSamples([]);
  });
  it("rolls back a failed batch instead of keeping partial history", () => {
    store = new Store(":memory:");
    expect(() => {
      store.insertSamples([
        { host: "a", key: "x", ts: 1, value: 10 },
        { host: "a", key: "x", ts: 2, value: NaN },
      ]);
    }).toThrow();
    expect(store.queryRange("a", "x", 0, 10)).toEqual([]);
  });
});
