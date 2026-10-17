import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fanFixture } from "../tests/plugins/fan-fixture.ts";
await test(
  "real Agent fan plugin uses local UDS, authenticates control and persists disablement",
  { timeout: 30000 },
  async (t) => {
    const folder = mkdtempSync("/tmp/archipel-fan-"),
      socket = join(folder, "control.sock");
    const calls: unknown[] = [];
    const authority = createServer((peer) => {
      let raw = "";
      peer.on("data", (part: Buffer) => {
        raw += part.toString();
        if (!raw.endsWith("\n")) return;
        const req: unknown = JSON.parse(raw);
        calls.push(req);
        peer.end(
          JSON.stringify(
            typeof req === "object" &&
              req !== null &&
              "op" in req &&
              req.op === "read"
              ? { ok: true, data: fanFixture() }
              : { ok: true, job_id: "local-task" },
          ) + "\n",
        );
      });
    });
    authority.listen(socket);
    await once(authority, "listening");
    const listener = createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const address = listener.address();
    assert(address && typeof address !== "string");
    await new Promise<void>((resolve) =>
      listener.close(() => {
        resolve();
      }),
    );
    const config = join(folder, "agent.toml"),
      binary =
        process.env.ARCHIPEL_AGENT_BIN ??
        join(
          import.meta.dirname,
          "../../agent/target/release/mini-archipel-agent",
        );
    writeFileSync(
      config,
      `bind="127.0.0.1:${String(address.port)}"\ntoken="test-only-token"\n[collectors]\nmacmon=""\nfanctl=""\ndisk_roots=[]\n[plugins.fan-control]\nenabled=true\n[plugins.fan-control.options]\ninterval_ms=1000\nallow_control=true\nsocket_path="${socket}"\n`,
      { mode: 0o600 },
    );
    assert.throws(() =>
      execFileSync(
        binary,
        ["configure-plugin", config, "fan-control", "true"],
        { input: '{"interval_ms":1}', stdio: ["pipe", "pipe", "pipe"] },
      ),
    );
    const child = spawn(binary, [config], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, HOME: folder },
    });
    let stderr = "";
    child.stderr.on("data", (v: Buffer) => {
      stderr += v.toString();
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, "exit");
        child.kill("SIGTERM");
        await exit;
      }
      await new Promise<void>((resolve) =>
        authority.close(() => {
          resolve();
        }),
      );
      rmSync(folder, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${String(address.port)}`;
    const request = (
      path: string,
      method = "GET",
      body?: unknown,
      auth = true,
    ) =>
      fetch(base + path, {
        method,
        headers: {
          ...(auth ? { authorization: "Bearer test-only-token" } : {}),
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5000),
      });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        const reply = await request("/snapshot");
        const state = (await reply.json()) as {
          plugins: Record<string, { status: string }>;
        };
        if (state.plugins["fan-control"]?.status === "ready") {
          ready = true;
          break;
        }
      } catch {}
      if (child.exitCode !== null) throw Error(stderr);
      await delay(50);
    }
    assert(ready, "plugin did not become ready");
    const action = "/plugins/fan-control/actions/command";
    assert.equal(
      (await request(action, "POST", { action: "system", data: {} }, false))
        .status,
      401,
    );
    assert.equal((await request(action, "POST", { op: "shell" })).status, 400);
    assert.equal(
      (
        await request(action, "POST", {
          request_id: "local-task",
          expected_revision: "a".repeat(64),
          action: "manual",
          data: { rpm: 2170, seconds: 5, method: "force" },
        })
      ).status,
      200,
    );
    assert(
      calls.some(
        (v) =>
          typeof v === "object" &&
          v !== null &&
          "op" in v &&
          v.op === "command",
      ),
    );
    assert.equal(
      (await request("/plugins/fan-control", "PUT", { enabled: false })).status,
      200,
    );
    assert.equal(
      (await request(action, "POST", { action: "system", data: {} })).status,
      409,
    );
    assert.equal((await request("/health")).status, 200);
  },
);
