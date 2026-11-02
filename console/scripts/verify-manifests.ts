import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { serverPlugins } from "../src/plugins/catalog.server.ts";

await test(
  "release reads manifests outside the checkout and fails if one is missing",
  { timeout: 20000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "archipel-manifests-"));
    t.after(() => {
      rmSync(directory, { recursive: true, force: true });
    });
    const release = join(directory, "release");
    const home = join(directory, "home");
    mkdirSync(home);
    cpSync(new URL("../dist/", import.meta.url), release, { recursive: true });
    const binary = join(release, "server.cjs");
    const options = {
      cwd: directory,
      env: { ...process.env, HOME: home },
      encoding: "utf8" as const,
      timeout: 10000,
    };
    const check = spawnSync(
      process.execPath,
      [binary, "--check-manifests"],
      options,
    );
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /Validated 5 plugin manifests/);

    const socket = createServer();
    socket.listen(0, "127.0.0.1");
    await once(socket, "listening");
    const address = socket.address();
    assert(address && typeof address !== "string");
    await new Promise<void>((resolve) => {
      socket.close(() => {
        resolve();
      });
    });
    const config = join(directory, "console.json");
    const token = "release-test-only";
    writeFileSync(
      config,
      JSON.stringify({
        bind: `127.0.0.1:${String(address.port)}`,
        uiToken: token,
        dbPath: join(directory, "history.db"),
        hosts: [
          {
            name: "isolated",
            kind: "virtual",
            url: "http://127.0.0.1:1",
            token: "test-only",
          },
        ],
        plugins: {},
      }),
    );
    const processUnderTest = spawn(process.execPath, [binary, config], {
      cwd: directory,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    processUnderTest.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    processUnderTest.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const stopped = once(processUnderTest, "exit");
    try {
      let state: { plugins: Record<string, { enabled: boolean }> } | undefined;
      for (let attempt = 0; attempt < 100; attempt++) {
        assert.equal(processUnderTest.exitCode, null, output);
        try {
          const response = await fetch(
            `http://127.0.0.1:${String(address.port)}/api/state`,
            {
              headers: { authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(250),
            },
          );
          if (response.ok) {
            state = (await response.json()) as typeof state;
            break;
          }
        } catch {
          /* The local server may still be starting. */
        }
        await delay(50);
      }
      assert(state, output);
      assert.deepEqual(
        Object.keys(state.plugins).sort(),
        serverPlugins.map((plugin) => plugin.id).sort(),
      );
      assert(Object.values(state.plugins).every((plugin) => !plugin.enabled));
    } finally {
      processUnderTest.kill("SIGTERM");
      const force = setTimeout(() => processUnderTest.kill("SIGKILL"), 3000);
      try {
        await stopped;
      } finally {
        clearTimeout(force);
      }
    }

    const missing = serverPlugins[0]?.id;
    assert(missing);
    rmSync(join(release, "manifests", `${missing}.toml`));
    const failure = spawnSync(
      process.execPath,
      [binary, "--check-manifests"],
      options,
    );
    assert.notEqual(failure.status, 0);
    assert.match(
      failure.stderr,
      new RegExp(`Missing or invalid plugin manifest: ${missing}`),
    );
  },
);
