import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { SnapshotSchema } from "../src/contracts.ts";
import { EnvelopeSchema } from "../src/plugins/contracts.ts";
import { AgentDataSchema } from "../src/plugins/runners/contracts.ts";

await test(
  "real agent: authenticated plugin lifecycle persists without restarting core or controlling CI",
  { timeout: 30000 },
  async (t) => {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address !== "string");
    const base = `http://127.0.0.1:${String(address.port)}`;
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
    const dir = mkdtempSync(join(tmpdir(), "fleet-agent-http-")),
      path = join(dir, "agent.toml"),
      token = "test-agent-token-only";
    writeFileSync(
      path,
      `bind = "127.0.0.1:${String(address.port)}"\ntoken = "${token}"\n[collectors]\nmacmon = ""\nfanctl = ""\ndisk_roots = []\n[plugins.runners]\nenabled = false\n[plugins.runners.options]\ninterval_ms = 1000\nallow_control = false\n`,
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
    const version = execFileSync(binary, ["--version"], {
      encoding: "utf8",
    }).trim();
    const original = readFileSync(path, "utf8");
    for (const [directory, repo] of [
      ["first", "owner-a/project"],
      ["second", "owner-b/project"],
    ]) {
      const installation = join(dir, "github-runners", directory ?? "");
      mkdirSync(installation, { recursive: true });
      writeFileSync(
        join(installation, ".runner"),
        "\ufeff" +
          JSON.stringify({
            agentName: "same-name",
            agentId: 7,
            gitHubUrl: `https://github.com/${repo ?? ""}`,
            workFolder: "_work",
          }),
      );
    }
    assert.throws(() =>
      execFileSync(binary, ["configure-plugin", path, "runners", "true"], {
        input: '{"interval_ms":1}',
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    assert.equal(readFileSync(path, "utf8"), original);
    execFileSync(binary, ["configure-plugin", path, "runners", "false"], {
      input: '{"interval_ms":1000}',
      stdio: ["pipe", "pipe", "pipe"],
    });
    assert.equal(
      execFileSync(binary, ["check-config", path], { encoding: "utf8" }).trim(),
      `127.0.0.1:${String(address.port)}`,
    );
    let child: ChildProcess | undefined,
      stderr = "";
    async function stop() {
      if (child?.exitCode === null && child.signalCode === null) {
        const exiting = once(child, "exit");
        child.kill("SIGTERM");
        await exiting;
      }
      child = undefined;
    }
    t.after(async () => {
      await stop();
      rmSync(dir, { recursive: true, force: true });
    });
    async function start() {
      stderr = "";
      child = spawn(binary, [path], {
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, HOME: dir },
      });
      child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });
      for (let i = 0; i < 100; i++) {
        try {
          const response = await fetch(base + "/health", {
            signal: AbortSignal.timeout(500),
          });
          if (response.ok) {
            assert.equal(await response.text(), version);
            return;
          }
        } catch {
          /* Wait for the process's listening socket. */
        }
        if (child.exitCode !== null) throw Error(`Agent exited: ${stderr}`);
        await delay(25);
      }
      throw Error("Agent startup timeout");
    }
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
    const request = (
      route: string,
      method = "GET",
      body?: unknown,
      authenticated = true,
    ) =>
      fetch(base + route, {
        method,
        headers: authenticated
          ? headers
          : { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5000),
      });
    async function snapshot() {
      const response = await request("/snapshot");
      assert.equal(response.status, 200);
      return SnapshotSchema.parse((await response.json()) as unknown);
    }
    await start();
    assert.equal(
      (await request("/snapshot", "GET", undefined, false)).status,
      401,
    );
    assert.equal(
      (await request("/plugins/runners", "PUT", { enabled: true }, false))
        .status,
      401,
    );
    assert.equal(
      (await request("/plugins/missing", "PUT", { enabled: true })).status,
      404,
    );
    assert.equal(
      (await request("/plugins/runners", "PUT", { enabled: "true" })).status,
      422,
    );
    assert.equal(
      (
        await request("/plugins/runners/actions/toggle", "POST", {
          runner: "unregistered",
          enable: false,
        })
      ).status,
      409,
    );
    let state = await snapshot();
    assert(!("runners" in state));
    assert.equal(EnvelopeSchema.parse(state.plugins.runners).enabled, false);
    const corePid = child?.pid;
    assert.equal(
      (await request("/plugins/runners", "PUT", { enabled: true })).status,
      200,
    );
    for (let i = 0; i < 100; i++) {
      state = await snapshot();
      if (
        state.sys &&
        EnvelopeSchema.parse(state.plugins.runners).status === "ready"
      )
        break;
      await delay(25);
    }
    assert(state.sys);
    assert.equal(EnvelopeSchema.parse(state.plugins.runners).status, "ready");
    const runnerEnvelope = EnvelopeSchema.parse(state.plugins.runners);
    assert.equal(runnerEnvelope.version, 2);
    assert.deepEqual(
      AgentDataSchema.parse(runnerEnvelope.data)
        .runners.map((r) => r.repo)
        .sort(),
      ["owner-a/project", "owner-b/project"],
    );
    assert.equal(child?.pid, corePid);
    assert.equal(
      (await request("/plugins/runners/actions/missing", "POST", {})).status,
      404,
    );
    assert.equal(
      (
        await request("/plugins/runners/actions/toggle", "POST", {
          runner: "unregistered",
          enable: false,
        })
      ).status,
      403,
    );
    assert.equal(
      (await request("/plugins/runners", "PUT", { enabled: false })).status,
      200,
    );
    state = await snapshot();
    assert.equal(EnvelopeSchema.parse(state.plugins.runners).enabled, false);
    assert.equal(EnvelopeSchema.parse(state.plugins.runners).data, null);
    assert(state.sys);
    assert.equal(child?.pid, corePid);
    assert.match(
      readFileSync(path, "utf8"),
      /\[plugins\.runners\]\s*enabled = false/,
    );
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal((await request("/runner-service", "POST", {})).status, 404);
    await stop();
    await start();
    state = await snapshot();
    assert.equal(EnvelopeSchema.parse(state.plugins.runners).enabled, false);
  },
);
