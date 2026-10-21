import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fanFixture } from "../tests/plugins/fan-fixture.ts";
await test(
  "real Agent fan telemetry survives plugin disablement and rejects stale samples",
  { timeout: 30000 },
  async (t) => {
    const folder = mkdtempSync("/tmp/archipel-fan-"),
      socket = join(folder, "control.sock");
    const calls: unknown[] = [];
    let telemetryError = false,
      staleTelemetry = false,
      futureTelemetry = false,
      unavailable = false;
    const authority = createServer((peer) => {
      let raw = "";
      peer.on("data", (part: Buffer) => {
        raw += part.toString();
        if (!raw.endsWith("\n")) return;
        if (unavailable) {
          peer.destroy();
          return;
        }
        const req: unknown = JSON.parse(raw);
        calls.push(req);
        const data = fanFixture();
        if (telemetryError) data.telemetry_error = "telemetry_unavailable";
        if (staleTelemetry) data.sampled_at -= 60000;
        if (futureTelemetry) data.sampled_at += 60000;
        peer.end(
          JSON.stringify(
            typeof req === "object" &&
              req !== null &&
              "op" in req &&
              req.op === "read"
              ? { ok: true, data }
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
      `bind="127.0.0.1:${String(address.port)}"\ntoken="test-only-token"\n[collectors]\nmacmon=""\nfanctl=""\nfan_socket="${socket}"\nfan_interval_ms=500\ndisk_roots=[]\n[plugins.fan-control]\nenabled=true\n[plugins.fan-control.options]\ninterval_ms=1000\nallow_control=true\nsocket_path="${socket}"\n`,
      { mode: 0o600 },
    );
    const original = readFileSync(config, "utf8");
    for (const fanctl of ["", "/Library/MacMiniFanControl/fanctl"]) {
      const legacyConfig = join(folder, "legacy.toml");
      writeFileSync(
        legacyConfig,
        original
          .replace(`fan_socket="${socket}"\n`, "")
          .replace('fanctl=""', `fanctl="${fanctl}"`),
        { mode: 0o600 },
      );
      execFileSync(
        binary,
        ["configure-plugin", legacyConfig, "fan-control", "false"],
        { input: "{}", stdio: ["pipe", "pipe", "pipe"] },
      );
      const migrated = readFileSync(legacyConfig, "utf8");
      assert(!/^fanctl\s*=/m.test(migrated));
      assert(
        migrated.includes(
          `fan_socket = "${fanctl ? "/var/run/mini-archipel/fan-control.sock" : ""}"`,
        ),
      );
    }
    for (const value of ["relative.sock", "/" + "a".repeat(101)]) {
      const invalid = join(folder, "invalid-socket.toml");
      writeFileSync(
        invalid,
        original.replace(`fan_socket="${socket}"`, `fan_socket="${value}"`),
        { mode: 0o600 },
      );
      assert.throws(() =>
        execFileSync(binary, ["check-config", invalid], { stdio: "pipe" }),
      );
    }
    assert.throws(() =>
      execFileSync(
        binary,
        ["configure-plugin", config, "fan-control", "true"],
        { input: '{"interval_ms":1}', stdio: ["pipe", "pipe", "pipe"] },
      ),
    );
    const tools = join(folder, "bin"),
      sysctlPid = join(folder, "sysctl.pid");
    mkdirSync(tools);
    writeFileSync(
      join(tools, "sysctl"),
      `#!/bin/sh\necho $$ > "${sysctlPid}"\nexec /bin/sleep 30\n`,
      { mode: 0o700 },
    );
    const child = spawn(binary, [config], {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        HOME: folder,
        PATH: tools + ":" + (process.env.PATH ?? ""),
      },
    });
    let stderr = "";
    child.stderr.on("data", (v: Buffer) => {
      stderr += v.toString();
    });
    t.after(async () => {
      if (existsSync(sysctlPid)) {
        try {
          process.kill(Number(readFileSync(sysctlPid, "utf8")), "SIGKILL");
        } catch {
          // The isolated fixture may already have exited.
        }
      }
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
    let metadata: { host: { model: string } | null } = { host: null };
    for (let i = 0; i < 40 && !metadata.host; i++) {
      metadata = (await (await request("/snapshot")).json()) as typeof metadata;
      if (!metadata.host) await delay(50);
    }
    assert(
      metadata.host?.model && metadata.host.model !== "unknown",
      "a blocked sysctl subprocess must not stall host metadata",
    );
    interface FanReading {
      temp: number;
      rpm: number;
      ts: number;
      error: boolean;
    }
    const waitForFan = async (predicate: (fan: FanReading) => boolean) => {
      for (let i = 0; i < 80; i++) {
        const state = (await (await request("/snapshot")).json()) as {
          fan: FanReading | null;
        };
        if (state.fan && predicate(state.fan)) return state.fan;
        await delay(50);
      }
      assert.fail("basic fan collector did not publish the expected reading");
    };
    const initial = await waitForFan((fan) => !fan.error);
    assert.equal(initial.temp, 34);
    assert.equal(initial.rpm, 1000);
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
    const disabledAt = Date.now();
    const independent = await waitForFan(
      (fan) => !fan.error && fan.ts > disabledAt,
    );
    assert(
      independent.ts > disabledAt,
      "plugin disable stopped basic sampling",
    );
    telemetryError = true;
    const failed = await waitForFan((fan) => fan.error);
    await delay(600);
    assert.equal((await waitForFan((fan) => fan.error)).ts, failed.ts);
    telemetryError = false;
    staleTelemetry = true;
    await delay(600);
    assert.equal((await waitForFan((fan) => fan.error)).ts, failed.ts);
    staleTelemetry = false;
    futureTelemetry = true;
    await delay(600);
    assert.equal((await waitForFan((fan) => fan.error)).ts, failed.ts);
    futureTelemetry = false;
    await waitForFan((fan) => !fan.error && fan.ts > failed.ts);
    unavailable = true;
    const disconnected = await waitForFan((fan) => fan.error);
    unavailable = false;
    await waitForFan((fan) => !fan.error && fan.ts > disconnected.ts);
  },
);
