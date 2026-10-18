import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { SnapshotSchema } from "../src/contracts.ts";
import { AgentDataSchema } from "../src/plugins/runners/contracts.ts";
import { EnvelopeSchema } from "../src/plugins/contracts.ts";

await test(
  "real agent and job hooks: node mutual exclusion, queued jobs, restart and crash recovery",
  { timeout: 30000 },
  async (t) => {
    const home = mkdtempSync(join(tmpdir(), "archipel-runner-policy-"));
    const hooks = join(home, ".local/libexec/mini-ci");
    mkdirSync(hooks, { recursive: true });
    copyFileSync(
      fileURLToPath(
        new URL("../../provisioning/scripts/ci-lease.py", import.meta.url),
      ),
      join(hooks, "ci-lease.py"),
    );
    for (const [script, command] of [
      ["job-started.sh", "start"],
      ["job-completed.sh", "complete"],
    ] as const)
      writeFileSync(
        join(hooks, script),
        `#!/bin/bash\nexec /usr/bin/python3 "$HOME/.local/libexec/mini-ci/ci-lease.py" ${command}\n`,
      );
    const listeners: ChildProcess[] = [],
      workers: ChildProcess[] = [];
    for (const repo of ["first", "second", "manual"]) {
      const directory = join(home, "runners", repo);
      mkdirSync(join(directory, "bin"), { recursive: true });
      writeFileSync(
        join(directory, ".runner"),
        JSON.stringify({
          agentName: repo,
          agentId: 1,
          gitHubUrl: `https://github.com/example/${repo}`,
          workFolder: "_work",
        }),
      );
      writeFileSync(
        join(directory, ".env"),
        `ACTIONS_RUNNER_HOOK_JOB_STARTED=${hooks}/job-started.sh\nACTIONS_RUNNER_HOOK_JOB_COMPLETED=${hooks}/job-completed.sh\n`,
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
        join(directory, "bin/Runner.Worker"),
      ]);
      execFileSync(
        "/usr/bin/clang",
        ["-x", "c", "-", "-o", join(directory, "bin/Runner.Listener")],
        {
          input: "#include <unistd.h>\nint main(void) { for (;;) pause(); }\n",
        },
      );
      if (repo !== "manual")
        listeners.push(
          spawn(join(directory, "bin/Runner.Listener"), [], {
            detached: true,
            stdio: "ignore",
          }),
        );
    }
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const address = reservation.address();
    assert(address && typeof address !== "string");
    await new Promise<void>((resolve) =>
      reservation.close(() => {
        resolve();
      }),
    );
    const url = `http://127.0.0.1:${String(address.port)}`,
      token = "fixture-policy-only",
      config = join(home, "agent.toml");
    const binary =
      process.env.ARCHIPEL_AGENT_BIN ??
      fileURLToPath(
        new URL(
          "../../agent/target/release/mini-archipel-agent",
          import.meta.url,
        ),
      );
    writeFileSync(
      config,
      `bind = "127.0.0.1:${String(address.port)}"\ntoken = "${token}"\n[collectors]\nmacmon = ""\nfanctl = ""\ndisk_roots = []\n[plugins.runners]\nenabled = true\n[plugins.runners.options]\ninterval_ms = 1000\nallow_control = true\n`,
      { mode: 0o600 },
    );
    let agent: ChildProcess | undefined;
    async function stopAgent() {
      if (agent?.exitCode === null && agent.signalCode === null) {
        const exited = once(agent, "exit");
        agent.kill("SIGTERM");
        await exited;
      }
    }
    t.after(async () => {
      await stopAgent();
      for (const child of [...workers, ...listeners])
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      rmSync(home, { recursive: true, force: true });
    });
    async function snapshot() {
      const result = await fetch(url + "/snapshot", {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(3000),
      });
      assert.equal(result.status, 200);
      return SnapshotSchema.parse(await result.json());
    }
    async function data() {
      return AgentDataSchema.parse(
        EnvelopeSchema.parse((await snapshot()).plugins.runners).data,
      );
    }
    async function until(condition: () => Promise<boolean> | boolean) {
      for (let i = 0; i < 120; i++) {
        if (await condition()) return;
        await delay(30);
      }
      throw Error("Runner policy did not settle");
    }
    async function startAgent() {
      agent = spawn(binary, [config], {
        env: { ...process.env, HOME: home },
        stdio: "ignore",
      });
      await until(async () => {
        try {
          return (await data()).coordination?.available === true;
        } catch {
          return false;
        }
      });
    }
    const command = (body: unknown, authenticated = true) =>
      fetch(url + "/plugins/runners/actions/coordination", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          request_id: crypto.randomUUID(),
          ...(body as Record<string, unknown>),
        }),
      });
    function worker(repo: string) {
      const child = spawn(
        join(home, "runners", repo, "bin/Runner.Worker"),
        [],
        {
          detached: true,
          env: {
            ...process.env,
            HOME: home,
            GITHUB_REPOSITORY: `example/${repo}`,
            MINI_CI_FIXTURE_READY: join(home, repo + ".ready"),
            MINI_CI_FIXTURE_RELEASE: join(home, repo + ".done"),
          },
          stdio: "ignore",
        },
      );
      workers.push(child);
      return child;
    }
    await startAgent();
    assert.equal((await command({ enable: true }, false)).status, 401);
    assert.equal((await command({ enable: "true" })).status, 400);
    assert.equal(
      (await command({ enable: true, unexpected: true })).status,
      400,
    );
    assert.equal((await command({ enable: true })).status, 200);
    await until(async () => (await data()).coordination?.enabled === true);
    const first = worker("first");
    await until(() => existsSync(join(home, "first.ready")));
    await until(
      async () =>
        (await data()).coordination?.paused.includes("second") === true,
    );
    assert(!existsSync(join(home, "runners/manual/.service")));
    // Simulate two assignments arriving together. The second Worker must wait at
    // the real start hook, with its Listener available to receive cancellation.
    const second = worker("second");
    await until(
      async () =>
        (await data()).coordination?.waiting.includes("second") === true,
    );
    assert(!existsSync(join(home, "second.ready")));
    await stopAgent();
    await startAgent();
    assert.equal((await data()).coordination?.enabled, true);
    assert.equal((await data()).coordination?.active_repo, "example/first");
    writeFileSync(join(home, "first.done"), "");
    await until(() => existsSync(join(home, "second.ready")));
    assert(
      !existsSync(join(home, "first.ready")),
      "job steps overlapped across repositories",
    );
    await until(
      async () =>
        (await data()).coordination?.paused.includes("first") === true,
    );
    assert.equal(first.exitCode, 0);
    // Local interruption / missing completion hook must still recover paused peers.
    second.kill("SIGKILL");
    await once(second, "exit");
    await until(async () => (await data()).coordination?.paused.length === 0);
    const recovered = (await data()).coordination;
    assert.equal(recovered?.active_repo, null);
    assert.equal((await command({ enable: false })).status, 200);
    await until(async () => (await data()).coordination?.enabled === false);
    const persisted: unknown = JSON.parse(
      readFileSync(
        join(home, ".local/state/mini-ci/runner-policy.json"),
        "utf8",
      ),
    );
    assert(
      persisted && typeof persisted === "object" && "enabled" in persisted,
    );
    assert.equal(persisted.enabled, false);
    assert(
      listeners.every(
        (child) => child.exitCode === null && child.signalCode === null,
      ),
    );
  },
);
