import { it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
it("drains every accepted write even when shutdown starts with a full queue", async () => {
  const dir = mkdtempSync(join(tmpdir(), "archipel-drain-")),
    path = join(dir, "test.db");
  const store = new Store(path);
  try {
    const writes = Array.from({ length: 256 }, (_, ts) =>
      store.insertSamples([{ host: "a", key: "cpu", ts, value: ts }]),
    );
    const close = store.close();
    expect(store.close()).toBe(close);
    await Promise.all([...writes, close]);
    const db = new DatabaseSync(path);
    try {
      expect(db.prepare("SELECT count(*) AS n FROM samples_raw").get()?.n).toBe(
        256,
      );
    } finally {
      db.close();
    }
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it("isolates SQLite lock waits from the main event loop and recovers after failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "archipel-worker-")),
    path = join(dir, "test.db");
  const store = new Store(path);
  let blocker: DatabaseSync | undefined;
  try {
    await store.queryRange("a", "cpu", 0, 10);
    blocker = new DatabaseSync(path);
    blocker.exec("BEGIN IMMEDIATE");
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
    }, 10);
    try {
      await expect(
        store.insertSamples([{ host: "a", key: "cpu", ts: 1, value: 20 }]),
      ).rejects.toThrow();
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(10);
    blocker.exec("ROLLBACK");
    await store.insertSamples([{ host: "a", key: "cpu", ts: 1, value: 20 }]);
    await store.downsampleAndPrune(10);
    expect(await store.queryRange("a", "cpu", 0, 10)).toEqual([
      { ts: 1, value: 20 },
    ]);
  } finally {
    blocker?.close();
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
