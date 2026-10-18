import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/app.ts";
import { loadConfig, saveConfig } from "../../src/config.ts";
import { FleetSchema, type Fleet } from "../../src/contracts.ts";
import {
  PluginManager,
  type PluginContext,
  type PluginDefinition,
} from "../../src/plugins/runtime.ts";
import { serverPlugins } from "../../src/plugins/catalog.server.ts";
import { config, makeSnapshot, TOKEN } from "../fixtures.ts";
const applications: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(applications.splice(0).map((x) => x.app.close()));
});
function setup(
  options: Partial<Parameters<typeof createApp>[1]> = {},
  settings = config,
) {
  const app = createApp(settings, {
    webDir: "public",
    startPolling: false,
    plugins: serverPlugins,
    transport: (url) =>
      Promise.resolve(
        url.endsWith("/snapshot") ? makeSnapshot() : { ok: true },
      ),
    ...options,
  });
  applications.push(app);
  return app;
}
const auth = { authorization: `Bearer ${TOKEN}` };
describe("plugin HTTP lifecycle", () => {
  it("disables only the selected plugin and rejects its actions while preserving core monitoring", async () => {
    const transport = vi.fn<PluginContext["transport"]>((url) =>
      Promise.resolve(
        url.endsWith("/snapshot") ? makeSnapshot() : { ok: true },
      ),
    );
    const { app, monitor } = setup({ transport });
    await monitor.poll();
    const endpoint = "/api/plugins/runners";
    expect(
      (
        await app.inject({
          method: "PUT",
          url: endpoint,
          payload: { enabled: false },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: endpoint,
          headers: { ...auth, origin: "https://evil.test" },
          payload: { enabled: false },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: endpoint,
          headers: auth,
          payload: { enabled: "no" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: endpoint,
          headers: auth,
          payload: { enabled: false },
        })
      ).statusCode,
    ).toBe(200);
    const state = FleetSchema.parse(
      (await app.inject({ url: "/api/state", headers: auth })).json(),
    );
    expect(state.plugins.runners?.enabled).toBe(false);
    expect(state.hosts.every((h) => h.online)).toBe(true);
    expect(state).not.toHaveProperty("github");
    expect(state.hosts[0]).not.toHaveProperty("ghRunners");
    expect(
      (
        await app.inject({
          method: "POST",
          url: endpoint + "/actions/toggle",
          headers: auth,
          payload: { host: "yd-mini", runner: "flowbit", enable: false },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      transport.mock.calls.some(([url]) => url.includes("/actions/")),
    ).toBe(false);
    expect(
      (
        await app.inject({
          url: "/api/history?host=yd-mini&key=cpu.usage_pct",
          headers: auth,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: endpoint,
          headers: auth,
          payload: { enabled: true },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/runner/toggle",
          headers: auth,
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/plugins/unknown",
          headers: auth,
          payload: { enabled: true },
        })
      ).statusCode,
    ).toBe(404);
  });
  it("uses the generic node plugin setting interface even with the console plugin off", async () => {
    const transport = vi.fn<PluginContext["transport"]>((url) =>
      Promise.resolve(
        url.endsWith("/snapshot") ? makeSnapshot() : { ok: true },
      ),
    );
    const { app } = setup({ transport });
    await app.inject({
      method: "PUT",
      url: "/api/plugins/runners",
      headers: auth,
      payload: { enabled: false },
    });
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/hosts/yd-mini/plugins/runners",
          headers: auth,
          payload: { enabled: false },
        })
      ).statusCode,
    ).toBe(200);
    expect(transport).toHaveBeenCalledWith(
      "http://yd-mini.test:9101/plugins/runners",
      "test-agent-token",
      { enabled: false },
      "PUT",
      expect.any(AbortSignal),
    );
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/hosts/missing/plugins/runners",
          headers: auth,
          payload: { enabled: true },
        })
      ).statusCode,
    ).toBe(404);
  });
  it("persists lifecycle changes across a new server instance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-plugin-persist-")),
      file = join(dir, "console.json");
    try {
      saveConfig(file, config);
      const first = setup({
        persistConfig: (value) => {
          saveConfig(file, value);
        },
      });
      await first.app.inject({
        method: "PUT",
        url: "/api/plugins/runners",
        headers: auth,
        payload: { enabled: false },
      });
      const second = setup({}, loadConfig(file));
      const state = (
        await second.app.inject({ url: "/api/state", headers: auth })
      ).json<Fleet>();
      expect(state.plugins.runners?.enabled).toBe(false);
      expect(loadConfig(file).plugins.runners?.options).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("runs the core with an empty catalog and preserves opaque extension data", async () => {
    const snapshot = makeSnapshot();
    snapshot.plugins = { future: { arbitrary: [1, { version: 900 }] } };
    const { app, monitor } = setup(
      { plugins: [], transport: () => Promise.resolve(snapshot) },
      { ...config, plugins: {} },
    );
    await monitor.poll();
    const state = FleetSchema.parse(
      (await app.inject({ url: "/api/state", headers: auth })).json(),
    );
    expect(state.plugins).toEqual({});
    expect(state.hosts[0]?.snapshot?.plugins).toEqual(snapshot.plugins);
    expect(state.hosts[0]?.online).toBe(true);
  });
});
describe("generic plugin runtime", () => {
  function probe(id: string): PluginDefinition {
    return {
      id,
      label: id,
      description: "test plugin",
      version: "1",
      create: () => ({
        read: () => ({ value: id }),
        start: vi.fn(),
        stop: vi.fn(),
        action: (_action, body) => Promise.resolve(body),
      }),
    };
  }
  function context(): PluginContext {
    return {
      hosts: () => [],
      pollHost: () => Promise.resolve(),
      command: () => Promise.resolve({ ok: true }),
      transport: () => Promise.resolve({}),
    };
  }
  it("loads a second plugin without changing the core and isolates initialization/read failures", async () => {
    const bad = probe("broken");
    bad.create = () => {
      throw Error("private-secret");
    };
    const readError = probe("read-error");
    readError.create = () => ({
      read: () => {
        throw Error("private-secret");
      },
      start: () => undefined,
      stop: () => undefined,
      action: () => Promise.resolve({}),
    });
    const manager = new PluginManager(
      {
        ...config,
        plugins: {
          example: { enabled: true, options: {} },
          broken: { enabled: true, options: {} },
          "read-error": { enabled: true, options: {} },
        },
      },
      context(),
      [probe("example"), bad, readError],
    );
    expect(manager.views().example?.data).toEqual({ value: "example" });
    expect(manager.views().broken?.error).toBeTruthy();
    expect(manager.views()["read-error"]?.error).toBeTruthy();
    expect(JSON.stringify(manager.views())).not.toContain("private-secret");
    await expect(manager.action("example", "echo", { ok: 1 })).resolves.toEqual(
      { ok: 1 },
    );
    await expect(manager.action("broken", "echo", {})).rejects.toThrow(
      "插件暂不可用",
    );
    await manager.setEnabled("broken", false);
    expect(manager.views().broken?.enabled).toBe(false);
  });
  it.each([
    () => 1n,
    () => {
      const value: Record<string, unknown> = {};
      value.self = value;
      return value;
    },
    () => Symbol("test"),
  ])(
    "contains non-JSON plugin state without breaking core serialization",
    (read) => {
      const definition = probe("example");
      definition.create = () => ({
        read,
        start: () => undefined,
        stop: () => undefined,
        action: () => Promise.resolve({}),
      });
      const manager = new PluginManager(
        { ...config, plugins: { example: { enabled: true, options: {} } } },
        context(),
        [definition],
      );
      expect(manager.views().example?.error).toBeTruthy();
      expect(() => JSON.stringify(manager.views())).not.toThrow();
    },
  );
  it("rolls back failed persistence and serializes lifecycle changes with running actions", async () => {
    const gate = Promise.withResolvers<unknown>(),
      definition = probe("example");
    definition.create = () => ({
      read: () => ({}),
      start: () => undefined,
      stop: () => undefined,
      action: () => gate.promise,
    });
    const manager = new PluginManager(
      { ...config, plugins: { example: { enabled: true, options: {} } } },
      context(),
      [definition],
    );
    const action = manager.action("example", "slow", {}),
      disabled = manager.setEnabled("example", false);
    await Promise.resolve();
    expect(manager.views().example?.enabled).toBe(true);
    gate.resolve({ ok: true });
    await action;
    await disabled;
    expect(manager.views().example?.enabled).toBe(false);
    const failed = new PluginManager(
      { ...config, plugins: { example: { enabled: true, options: {} } } },
      context(),
      [probe("example")],
      () => {
        throw Error("disk full");
      },
    );
    await expect(failed.setEnabled("example", false)).rejects.toThrow(
      "原状态保持不变",
    );
    expect(failed.views().example?.enabled).toBe(true);
  });
  it("lets independent operations and cancellation run while another action waits", async () => {
    const gate = Promise.withResolvers<unknown>();
    const definition = probe("example");
    const calls: string[] = [];
    definition.create = () => ({
      read: () => ({}),
      start: () => undefined,
      stop: () => undefined,
      action: async (action) => {
        calls.push(action);
        if (action === "slow") return gate.promise;
        return { ok: true };
      },
    });
    const manager = new PluginManager(
      { ...config, plugins: { example: { enabled: true, options: {} } } },
      context(),
      [definition],
    );
    const waiting = manager.action("example", "slow", { host: "a" });
    await manager.action("example", "cancel", { host: "b" });
    expect(calls).toEqual(["slow", "cancel"]);
    gate.resolve({ ok: true });
    await waiting;
  });
});
it("keeps runner implementation out of core modules", () => {
  const files = [
    "config.ts",
    "contracts.ts",
    "domain.ts",
    "fleet.ts",
    "app.ts",
    "web/App.tsx",
    "web/overview.tsx",
    "web/node.tsx",
    "web/ui.tsx",
    "web/api.ts",
    "web/useFleet.ts",
    "web/plugins.tsx",
    "web/plugin-settings.tsx",
    "web/styles.css",
    "plugins/runtime.ts",
    "plugins/contracts.ts",
  ];
  for (const file of files)
    expect(
      readFileSync(new URL(`../../src/${file}`, import.meta.url), "utf8"),
      file,
    ).not.toMatch(/\brunners?\b|github/i);
  for (const file of [
    "main.rs",
    "config.rs",
    "collectors/mod.rs",
    "plugins/mod.rs",
  ])
    expect(
      readFileSync(
        new URL(`../../../agent/src/${file}`, import.meta.url),
        "utf8",
      ),
      file,
    ).not.toMatch(/\brunners?\b|github/i);
});
