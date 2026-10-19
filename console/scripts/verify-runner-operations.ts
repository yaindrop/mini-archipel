import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { SnapshotSchema } from "../src/contracts.ts";
import { AgentDataSchema } from "../src/plugins/runners/contracts.ts";
import { EnvelopeSchema } from "../src/plugins/contracts.ts";

await test(
  "real agent: durable asynchronous Runner receipts, idempotency and restart recovery",
  { timeout: 30000 },
  async (t) => {
    const home = mkdtempSync(join(tmpdir(), "archipel-runner-operations-")),
      hooks = join(home, ".local/libexec/mini-archipel/ci");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(
      join(hooks, "ci-lease.py"),
      `from pathlib import Path
import sys,json,time
h=Path.home();p=h/'effects';enabled=h/'enabled'
if sys.argv[1]!='state':
 r=json.load(sys.stdin)
 with p.open('a') as f:f.write('effect\\n')
 if r['enable']:enabled.touch()
 else:enabled.unlink(missing_ok=True)
 time.sleep(7)
print(json.dumps(dict(available=True,enabled=enabled.exists(),active_repo=None,paused=[],waiting=[],error=None)))
`,
    );
    const reservation = createServer().listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const address = reservation.address();
    assert(address && typeof address !== "string");
    await new Promise<void>((resolve) =>
      reservation.close(() => {
        resolve();
      }),
    );
    const url = `http://127.0.0.1:${String(address.port)}`,
      config = join(home, "agent.toml"),
      token = "fixture-operations-only";
    writeFileSync(
      config,
      `bind="127.0.0.1:${String(address.port)}"\ntoken="${token}"\n[collectors]\nmacmon=""\nfanctl=""\ndisk_roots=[]\n[plugins.runners]\nenabled=true\n[plugins.runners.options]\ninterval_ms=1000\nallow_control=true\n`,
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
    async function stop() {
      if (agent?.exitCode === null && agent.signalCode === null) {
        const exited = once(agent, "exit");
        agent.kill("SIGTERM");
        await exited;
      }
    }
    t.after(async () => {
      await stop();
      rmSync(home, { recursive: true, force: true });
    });
    async function snapshot() {
      const r = await fetch(url + "/snapshot", {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2000),
      });
      assert.equal(r.status, 200);
      return SnapshotSchema.parse(await r.json());
    }
    async function data() {
      return AgentDataSchema.parse(
        EnvelopeSchema.parse((await snapshot()).plugins.runners).data,
      );
    }
    async function until(condition: () => Promise<boolean> | boolean) {
      for (let i = 0; i < 500; i++) {
        if (await condition()) return;
        await delay(20);
      }
      throw Error("operation did not settle");
    }
    async function start() {
      agent = spawn(binary, [config], {
        env: { ...process.env, HOME: home, TOKIO_WORKER_THREADS: "1" },
        stdio: "ignore",
      });
      await until(async () => {
        try {
          return (await data()).operations !== undefined;
        } catch {
          return false;
        }
      });
    }
    const command = (id: string, enable: boolean) =>
      fetch(url + "/plugins/runners/actions/coordination", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ request_id: id, enable }),
        signal: AbortSignal.timeout(2000),
      });
    const receipt = z.object({
      ok: z.literal(true),
      operation: z.object({ id: z.string(), status: z.string() }),
    });
    const effects = () =>
      existsSync(join(home, "effects"))
        ? readFileSync(join(home, "effects"), "utf8").trim().split("\n").length
        : 0;
    await start();
    await until(async () => (await snapshot()).sys !== null);
    const id = crypto.randomUUID(),
      begin = performance.now(),
      accepted = await command(id, true);
    assert.equal(accepted.status, 200);
    assert(
      performance.now() - begin < 1500,
      "submission waited for the operation",
    );
    assert.equal(receipt.parse(await accepted.json()).operation.id, id);
    await until(() => effects() === 1);
    assert.equal((await command(id, true)).status, 200);
    assert.equal((await command(id, false)).status, 409);
    const baseline = await snapshot();
    await delay(1200);
    const live = await snapshot();
    assert(
      live.sys && baseline.sys && live.sys.ts > baseline.sys.ts,
      "main monitoring stalled during an operation",
    );
    await until(
      async () =>
        (await data()).operations?.find((job) => job.id === id)?.status ===
        "completed",
    );
    assert.equal(effects(), 1);
    const next = crypto.randomUUID();
    assert.equal((await command(next, false)).status, 200);
    await until(() => effects() === 2);
    await stop();
    await start();
    assert.equal(
      (await data()).operations?.find((job) => job.id === next)?.status,
      "interrupted",
    );
    const retry = await command(next, false);
    assert.equal(retry.status, 200);
    assert.equal(
      receipt.parse(await retry.json()).operation.status,
      "interrupted",
    );
    await delay(200);
    assert.equal(effects(), 2, "restart replayed an uncertain mutation");
  },
);
