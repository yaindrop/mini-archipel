import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { ConsoleConfigSchema, loadConfig, saveConfig } from "../src/config.ts";
import { config } from "./fixtures.ts";
describe("validated configuration", () => {
  it("retains opaque namespaced plugin options", () => {
    const plugins = {
      example: {
        enabled: true,
        options: { secret: "private-test-token", nested: { future: 1 } },
      },
    };
    expect(ConsoleConfigSchema.parse({ ...config, plugins }).plugins).toEqual(
      plugins,
    );
  });
  it.each([
    { hosts: [] },
    { hosts: [config.hosts[0], config.hosts[0]] },
    { githubToken: "legacy" },
    { bind: "invalid" },
    { hosts: [{ name: "test", url: "file:///etc/passwd", token: "x" }] },
    { plugins: { "bad/id": { enabled: true } } },
    { hosts: [{ ...config.hosts[0], kind: "tart" }] },
    { hosts: [{ ...config.hosts[0], kind: "apple-silicon" }] },
    { hosts: [{ ...config.hosts[0], kind: undefined }] },
  ])("rejects invalid configuration %j", (patch) => {
    expect(ConsoleConfigSchema.safeParse({ ...config, ...patch }).success).toBe(
      false,
    );
  });
  it("persists plugin settings atomically, privately and without dropping options", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-config-")),
      p = join(dir, "console.json");
    try {
      writeFileSync(p, JSON.stringify({ ...config, dbPath: "~/fleet.db" }));
      const loaded = loadConfig(p);
      expect(loaded.dbPath).toBe(join(homedir(), "fleet.db"));
      loaded.plugins.runners = { enabled: false, options: { secret: "kept" } };
      saveConfig(p, loaded);
      expect(loadConfig(p).plugins.runners).toEqual(loaded.plugins.runners);
      expect(loadConfig(p).hosts).toEqual(config.hosts);
      expect(statSync(p).mode & 0o777).toBe(0o600);
      writeFileSync(
        p,
        JSON.stringify({
          ...config,
          hosts: [{ name: "x", url: "invalid", token: "private-test-token" }],
        }),
      );
      expect(() => loadConfig(p)).toThrow("hosts");
      expect(() => loadConfig(p)).not.toThrow("private-test-token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
