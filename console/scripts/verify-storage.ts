import { DiskRulesViewSchema } from "../src/storage-rules.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  SnapshotSchema,
  type Snapshot,
  type ScanNode,
} from "../src/contracts.ts";
await test(
  "real agent: configured policy, lazy replacement, permissions and durable cancellation",
  { timeout: 30000 },
  async (t) => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "archipel-storage-")));
    for (const path of [
      "Library/Caches/pkg/deep/leaf",
      ".local/share/database",
      "work/tree/one/two",
      "Applications/Tool.app/Contents",
      "blocked",
    ]) {
      mkdirSync(join(home, path), { recursive: true });
      writeFileSync(join(home, path, "data"), new Uint8Array(4096));
    }
    chmodSync(join(home, "blocked"), 0);
    symlinkSync(join(home, "work"), join(home, "link"));
    const { createServer } = await import("node:net");
    const port = createServer().listen(0, "127.0.0.1");
    await once(port, "listening");
    const address = port.address();
    assert(address && typeof address !== "string");
    await new Promise<void>((resolve) =>
      port.close(() => {
        resolve();
      }),
    );
    const config = join(home, "agent.toml"),
      token = "fixture-storage-only",
      base = `http://127.0.0.1:${String(address.port)}`;
    writeFileSync(
      config,
      `bind = "127.0.0.1:${String(address.port)}"\ntoken = "${token}"\n[collectors]\nmacmon = ""\nfanctl = ""\ndisk_roots = ["${home}"]\n[[collectors.disk.rules]]\npath = "~/work"\ndepth = 2\nclass = "user"\n[[collectors.disk.rules]]\npath = "~/Library/Caches"\nclass = "appdata"\n`,
      { mode: 0o600 },
    );
    const binary =
      process.env.ARCHIPEL_AGENT_BIN ??
      fileURLToPath(
        new URL(
          "../../agent/target/release/mini-archipel-agent",
          import.meta.url,
        ),
      );
    let agent: ChildProcess | undefined;
    const request = (path = "snapshot", body?: unknown, method = "POST") =>
      fetch(`${base}/${path}`, {
        method: body === undefined ? "GET" : method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(2000),
      });
    async function snapshot() {
      return SnapshotSchema.parse(await (await request()).json());
    }
    async function waitFor(predicate: (state: Snapshot) => boolean) {
      for (let n = 0; n < 200; n++) {
        const state = await snapshot();
        if (predicate(state)) return state;
        await delay(20);
      }
      throw Error("storage did not reach expected state");
    }
    async function start() {
      agent = spawn(binary, [config], {
        env: { ...process.env, HOME: home, TOKIO_WORKER_THREADS: "1" },
        stdio: "ignore",
      });
      for (let n = 0; n < 100; n++) {
        try {
          if ((await request("health")).ok) return;
        } catch {
          /* Starting. */
        }
        await delay(20);
      }
      throw Error("Agent did not start");
    }
    async function stop() {
      if (agent?.exitCode === null && agent.signalCode === null) {
        const done = once(agent, "exit");
        agent.kill("SIGTERM");
        await done;
      }
      agent = undefined;
    }
    t.after(async () => {
      await stop();
      chmodSync(join(home, "blocked"), 0o700);
      rmSync(home, { recursive: true, force: true });
    });
    function node(state: Snapshot, path: string): ScanNode {
      let row = state.disk_scans.find((s) => s.root === home);
      assert(row);
      for (const part of path.split("/").filter(Boolean)) {
        row = row.children.find((s) => s.root === part);
        assert(row, path);
      }
      return row;
    }
    async function scan(path?: string) {
      const response = await request(
        "rescan-disk",
        path ? { path: join(home, path) } : {},
      );
      assert.equal(response.status, 200);
      return waitFor((s) => s.disk_scan.status === "completed");
    }
    await start();
    let state = await waitFor((s) => s.disk_scan.status === "completed");
    assert.equal(
      node(state, "Library/Caches/pkg").children_status,
      "unscanned",
    );
    assert.equal(node(state, "Library/Caches/pkg").class, "appdata");
    assert.equal(node(state, ".local/share/database").class, "appdata");
    assert.equal(node(state, "work/tree/one").children_status, "unscanned");
    assert.equal(
      node(state, "Applications/Tool.app").children_status,
      "excluded",
    );
    assert.equal(node(state, "blocked").children_status, "unreadable");
    const untouched = node(state, ".local");
    state = await scan("Library/Caches/pkg");
    assert.equal(
      node(state, "Library/Caches/pkg/deep").children_status,
      "unscanned",
    );
    assert.deepEqual(node(state, ".local"), untouched);
    assert.equal(state.disk_scan.target, join(home, "Library/Caches/pkg"));
    state = await scan("Library/Caches/pkg/deep");
    assert.equal(node(state, "Library/Caches/pkg/deep/leaf").root, "leaf");
    await stop();
    await start();
    assert.deepEqual((await snapshot()).disk_scans, state.disk_scans);
    state = await scan();
    assert.equal(node(state, "Library/Caches/pkg/deep/leaf").root, "leaf");
    // Rules are saved atomically, hot-applied without restarting, and isolated from scan jobs.
    const original = DiskRulesViewSchema.parse(
      await (await request("disk-rules")).json(),
    );
    assert(original.defaults.some((r) => r.path === "~/Library/Caches"));
    assert(!JSON.stringify(original).includes(token));
    assert.equal((await fetch(`${base}/disk-rules`)).status, 401);
    const baseline = state.disk_scans;
    const ruleConfig = {
      ...original.config,
      rules: [
        ...original.config.rules.filter((r) => r.path !== "~/work"),
        { path: "~/work", depth: 3, class: "toolchain" },
      ],
    };
    const update = { revision: original.revision, config: ruleConfig };
    const changedResponse = await request("disk-rules", update, "PUT");
    assert.equal(changedResponse.status, 200);
    const changed = DiskRulesViewSchema.parse(await changedResponse.json());
    assert.notEqual(changed.revision, original.revision);
    assert.deepEqual((await snapshot()).disk_scans, baseline);
    assert.equal((await request("disk-rules", update, "PUT")).status, 409);
    for (const rules of [
      [{ path: "~/work", depth: 5 }],
      [{ path: "~/../etc", depth: 1 }],
      [{ path: "~/work" }, { path: home + "/work/" }],
    ]) {
      assert.equal(
        (
          await request(
            "disk-rules",
            {
              revision: changed.revision,
              config: { use_defaults: true, rules },
            },
            "PUT",
          )
        ).status,
        400,
      );
    }
    state = await scan("work");
    assert.equal(node(state, "work").class, "toolchain");
    state = await scan();
    assert.equal(node(state, "work/tree/one/two").class, "toolchain");
    await stop();
    await start();
    assert.equal(
      DiskRulesViewSchema.parse(await (await request("disk-rules")).json())
        .revision,
      changed.revision,
    );
    assert.equal(
      (
        await request(
          "disk-rules",
          { revision: changed.revision, config: original.config },
          "PUT",
        )
      ).status,
      200,
    );
    state = await scan();
    const readableCache = state.disk_scans;
    assert.equal(
      (await request("rescan-disk", { path: join(home, "blocked") })).status,
      200,
    );
    state = await waitFor((s) => s.disk_scan.status === "failed");
    assert.deepEqual(state.disk_scans, readableCache);
    for (const path of [
      "/",
      `${home}/../outside`,
      join(home, "link"),
      join(home, "Applications/Tool.app"),
      join(home, "work/missing"),
    ])
      assert.equal((await request("rescan-disk", { path })).status, 400, path);
    const before = state.disk_scans;
    const accepted = await request("rescan-disk", {
      path: join(home, "work/tree/one"),
    });
    assert.equal(accepted.status, 200);
    const job = ((await accepted.json()) as { job: { id: number } }).job;
    assert.equal((await request("rescan-disk", {})).status, 409);
    assert.equal(
      (await request("cancel-disk-scan", { id: job.id })).status,
      200,
    );
    state = await waitFor((s) => s.disk_scan.status === "cancelled");
    assert.deepEqual(state.disk_scans, before);
    await stop();
    await start();
    assert.equal((await snapshot()).disk_scan.status, "cancelled");
    assert.deepEqual((await snapshot()).disk_scans, before);
    const cache = JSON.parse(
      readFileSync(
        join(home, ".local/share/mini-archipel/disk-scan.json"),
        "utf8",
      ),
    ) as { job: { status: string } };
    assert.equal(cache.job.status, "cancelled");
  },
);
