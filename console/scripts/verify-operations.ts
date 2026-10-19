import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { SnapshotSchema } from "../src/contracts.ts";
import { AgentDataSchema } from "../src/plugins/runners/contracts.ts";
import { EnvelopeSchema } from "../src/plugins/contracts.ts";

await test(
  "real agent: cancellable durable scans and isolated local Worker interruption",
  { timeout: 60000 },
  async (t) => {
    const home = mkdtempSync(join(tmpdir(), "archipel-operations-"));
    const binary =
      process.env.ARCHIPEL_AGENT_BIN ??
      fileURLToPath(
        new URL(
          "../../agent/target/release/mini-archipel-agent",
          import.meta.url,
        ),
      );
    const token = "fixture-operations-only";
    const config = join(home, "agent.toml");
    const scanRoot = join(home, "scan-fixture");
    mkdirSync(scanRoot);
    // A private tree keeps cancellation deterministic without touching real user data.
    for (let i = 0; i < 12000; i++) {
      const directory = join(scanRoot, String(i));
      mkdirSync(directory);
      writeFileSync(join(directory, "file"), "fixture");
    }
    const base = "http://127.0.0.1:0";
    // Reserve a port briefly, then let the real agent bind it.
    const { createServer } = await import("node:net");
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const address = reservation.address();
    assert(address && typeof address !== "string");
    const url = base.replace(":0", ":" + String(address.port));
    await new Promise<void>((resolve) =>
      reservation.close(() => {
        resolve();
      }),
    );
    writeFileSync(
      config,
      `bind = "127.0.0.1:${String(address.port)}"\ntoken = "${token}"\n[collectors]\nmacmon = ""\nfanctl = ""\ndisk_roots = [${JSON.stringify(scanRoot)}]\n[plugins.runners]\nenabled = true\n[plugins.runners.options]\ninterval_ms = 1000\nallow_control = true\n`,
      { mode: 0o600 },
    );
    const cached = {
      root: scanRoot,
      class: "root",
      bytes: 4096,
      children: [
        {
          root: "previous",
          class: "user",
          bytes: 4096,
          children: [],
          ts: 1,
          duration_ms: 1,
          partial: false,
          children_status: "unscanned",
          error: null,
        },
      ],
      ts: Date.now(),
      duration_ms: 1,
      partial: false,
      children_status: "unscanned",
      error: null,
    };
    const data = join(home, ".local/share/mini-archipel");
    mkdirSync(data, { recursive: true });
    writeFileSync(
      join(data, "disk-scan.json"),
      JSON.stringify({
        job: {
          id: 1,
          status: "completed",
          requested_at: 1,
          started_at: 1,
          finished_at: Date.now(),
          current_root: null,
          error: null,
        },
        scans: { [scanRoot]: cached },
      }),
      { mode: 0o600 },
    );
    const install = join(home, "runners/fixture");
    mkdirSync(join(install, "bin"), { recursive: true });
    writeFileSync(
      join(install, ".runner"),
      JSON.stringify({
        agentName: "fixture",
        agentId: 1,
        gitHubUrl: "https://github.com/example/fixture",
        workFolder: "_work",
      }),
    );
    execFileSync("/usr/bin/clang", [
      "-Wall",
      "-Wextra",
      "-Werror",
      fileURLToPath(
        new URL(
          "../../provisioning/scripts/tests/hook-worker.c",
          import.meta.url,
        ),
      ),
      "-o",
      join(install, "bin/Runner.Worker"),
    ]);
    execFileSync(
      "/usr/bin/clang",
      ["-x", "c", "-", "-o", join(install, "bin/Runner.Listener")],
      {
        input:
          "#include <unistd.h>\nint main(void) { sleep(120); return 0; }\n",
      },
    );
    const hooks = join(home, ".local/libexec/mini-archipel/ci");
    mkdirSync(hooks, { recursive: true });
    // Continually forking descendants in separate sessions remain descendants;
    // termination must quiesce them rather than rely on one process-group signal.
    execFileSync(
      "/usr/bin/clang",
      ["-x", "c", "-", "-o", join(home, "fork-fixture")],
      {
        input:
          "#include <unistd.h>\n#include <stdlib.h>\nint main(void) { for(int i=0;i<30;i++) { if(fork()==0) { setsid(); sleep(120); _exit(0); } usleep(30000); } sleep(120); return 0; }\n",
      },
    );
    writeFileSync(
      join(hooks, "job-started.sh"),
      '#!/bin/bash\nexec "$HOME/fork-fixture"\n',
    );
    writeFileSync(join(hooks, "job-completed.sh"), "#!/bin/bash\nexit 0\n");
    const worker = spawn(join(install, "bin/Runner.Worker"), [], {
      detached: true,
      env: { ...process.env, HOME: home },
      stdio: "ignore",
    });
    const listener = spawn(join(install, "bin/Runner.Listener"), ["120"], {
      stdio: "ignore",
    });
    const unrelated = spawn("/bin/sleep", ["120"], { stdio: "ignore" });
    let agent: ChildProcess | undefined;
    async function stopAgent() {
      if (agent?.exitCode === null && agent.signalCode === null) {
        const exited = once(agent, "exit");
        agent.kill("SIGTERM");
        await exited;
      }
      agent = undefined;
    }
    t.after(async () => {
      await stopAgent();
      if (worker.pid) {
        try {
          process.kill(-worker.pid, "SIGKILL");
        } catch {
          /* Group already exited. */
        }
      }
      for (const child of [worker, listener, unrelated]) {
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          if (child === worker) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              /* Already reaped. */
            }
          } else child.kill("SIGKILL");
        }
      }
      rmSync(home, { recursive: true, force: true });
    });
    const request = (path: string, body?: unknown, method = "POST") =>
      fetch(url + path, {
        method: body === undefined ? "GET" : method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        ...(body === undefined
          ? {}
          : {
              body: JSON.stringify(
                path.startsWith("/plugins/runners/actions/")
                  ? {
                      request_id: crypto.randomUUID(),
                      ...(body as Record<string, unknown>),
                    }
                  : body,
              ),
            }),
        signal: AbortSignal.timeout(2000),
      });
    async function startAgent() {
      agent = spawn(binary, [config], {
        env: { ...process.env, HOME: home, TOKIO_WORKER_THREADS: "1" },
        stdio: "ignore",
      });
      for (let i = 0; i < 100; i++) {
        try {
          if ((await request("/health")).ok) return;
        } catch {
          /* Starting. */
        }
        await delay(20);
      }
      throw Error("agent startup timeout");
    }
    async function snapshot() {
      const response = await request("/snapshot");
      assert.equal(response.status, 200);
      return SnapshotSchema.parse(await response.json());
    }
    async function waitStatus(status: string) {
      for (let i = 0; i < 100; i++) {
        const state = await snapshot();
        if (state.disk_scan.status === status) return state;
        await delay(20);
      }
      throw Error("scan state did not reach " + status);
    }
    await startAgent();
    const initial = await snapshot();
    assert.deepEqual(initial.disk_scans, [cached]);
    assert(initial.disk_revision);
    const unchanged = await request(
      "/snapshot?disk_revision=" + encodeURIComponent(initial.disk_revision),
    );
    assert.equal(unchanged.status, 200);
    assert.equal(
      Object.hasOwn((await unchanged.json()) as object, "disk_scans"),
      false,
    );
    assert.equal((await request("/rescan-disk", {})).status, 200);
    let state = await waitStatus("running");
    assert.deepEqual(state.disk_scans, [cached]);
    const scanId = state.disk_scan.id;
    assert.equal((await request("/rescan-disk", {})).status, 200);
    assert.equal((await snapshot()).disk_scan.id, scanId);
    assert.equal(
      (await request("/cancel-disk-scan", { id: scanId + 1 })).status,
      409,
    );
    assert.equal(
      (await request("/cancel-disk-scan", { id: scanId })).status,
      200,
    );
    state = await waitStatus("cancelled");
    assert.deepEqual(state.disk_scans, [cached]);
    await stopAgent();
    await startAgent();
    state = await snapshot();
    assert.equal(state.disk_scan.status, "cancelled");
    assert.deepEqual(state.disk_scans, [cached]);
    assert.equal((await request("/rescan-disk", {})).status, 200);
    await waitStatus("running");
    await stopAgent();
    await startAgent();
    state = await snapshot();
    assert.equal(state.disk_scan.status, "interrupted");
    assert.deepEqual(state.disk_scans, [cached]);
    for (let i = 0; i < 100; i++) {
      state = await snapshot();
      const envelope = EnvelopeSchema.parse(state.plugins.runners);
      if (
        envelope.status === "ready" &&
        AgentDataSchema.parse(envelope.data).runners[0]?.worker_pid ===
          worker.pid
      )
        break;
      await delay(20);
    }
    const command = {
      repo: "example/fixture",
      runner: "fixture",
      worker_pid: worker.pid,
    };
    const descendants = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,stat="])
      .toString()
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/));
    const owned = new Set([String(worker.pid)]);
    let previous = 0;
    while (owned.size !== previous) {
      previous = owned.size;
      for (const [pid, parent] of descendants)
        if (parent && pid && owned.has(parent)) owned.add(pid);
    }
    assert(owned.size > 1, "fixture Worker must have a running job descendant");
    assert.equal(
      listener.signalCode,
      null,
      "Listener must be alive before interruption",
    );
    assert.equal(
      (
        await request("/plugins/runners/actions/interrupt", {
          ...command,
          worker_pid: Number(worker.pid) + 1,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await request("/plugins/runners/actions/toggle", {
          repo: command.repo,
          runner: command.runner,
          enable: false,
        })
      ).status,
      409,
    );
    const interrupted = await request(
      "/plugins/runners/actions/interrupt",
      command,
    );
    assert.equal(interrupted.status, 200, await interrupted.text());
    if (worker.exitCode === null && worker.signalCode === null)
      await once(worker, "exit");
    assert.equal(listener.exitCode, null);
    assert.equal(listener.signalCode, null);
    assert.equal(unrelated.exitCode, null);
    assert.equal(unrelated.signalCode, null);
    const remaining = execFileSync("/bin/ps", ["-axo", "pid=,stat=,comm="])
      .toString()
      .trim()
      .split("\n");
    for (const line of remaining) {
      const [pid, status] = line.trim().split(/\s+/);
      assert(
        !line.includes(join(home, "fork-fixture")) || status?.startsWith("Z"),
        "newly forked or separate-session descendant survived",
      );
      assert(
        !pid || !owned.has(pid) || status?.startsWith("Z"),
        "job descendant survived interruption",
      );
    }
    assert.equal((await request("/health")).status, 200);
  },
);
