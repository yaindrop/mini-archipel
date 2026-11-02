import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { serverPlugins } from "../../src/plugins/catalog.server.ts";
import { workbenchPlugins } from "../../src/plugins/catalog.web.tsx";
import {
  manifestUrl,
  parseManifest,
  registerPlugins,
  validateManifests,
} from "../../src/plugins/manifest.ts";

const source = readFileSync(manifestUrl("proxy"), "utf8");
const first = serverPlugins[0];
assert(first);

describe("plugin manifests", () => {
  it("checks the explicit catalogs and retains the declared deployment exceptions", () => {
    expect(serverPlugins.map((plugin) => plugin.id)).toEqual(
      workbenchPlugins.map((plugin) => plugin.id),
    );
    const manifests = Object.fromEntries(
      serverPlugins.map((plugin) => [plugin.id, plugin.manifest]),
    );
    expect(manifests.proxy?.paths?.program?.legacy_paths).toEqual([
      "~/.local/mini-proxy",
    ]);
    expect(manifests.automation?.services).toBeUndefined();
    expect(manifests["screen-recording"]?.services).toBeUndefined();
    expect(manifests.automation?.bundle_id).toBe(
      "local.yaindrop.agent-script-runner",
    );
    expect(manifests["screen-recording"]?.bundle_id).toBe(
      "org.agent-screen-recorder.app",
    );
    expect(
      Object.values(manifests["fan-control"]?.services ?? {})
        .map((service) => service.label)
        .sort(),
    ).toEqual(["local.miniarchipel.fan-control", "local.miniarchipel.fanctl"]);
    expect(manifests["fan-control"]?.paths?.root_program?.migration).toBe(
      "fixed",
    );
    expect(manifests.runners?.services?.official?.owner).toBe("external");
    expect(
      Object.values(manifests.runners?.paths ?? {}).every(
        (resource) => resource.migration === "fixed",
      ),
    ).toBe(true);
    expect(registerPlugins([])).toEqual([]);
    expect(registerPlugins([first]).map((plugin) => plugin.id)).toEqual([
      first.id,
    ]);
  });

  it.each([
    ["version", source.replace("schema_version = 1", "schema_version = 2")],
    [
      "unknown field",
      source.replace("schema_version = 1", "schema_version = 1\nextra = true"),
    ],
    [
      "duplicate field",
      source.replace(
        "schema_version = 1",
        "schema_version = 1\nschema_version = 1",
      ),
    ],
    ["ID mismatch", source.replace('id = "proxy"', 'id = "other"')],
    [
      "self alias",
      source.replace('legacy_ids = ["mini-proxy"]', 'legacy_ids = ["proxy"]'),
    ],
    [
      "external move",
      source.replaceAll('owner = "plugin"', 'owner = "external"'),
    ],
    [
      "wrong root",
      source.replaceAll(
        "~/.local/libexec/mini-archipel/proxy",
        "~/.local/libexec/mini-archipel/other",
      ),
    ],
    ["traversal", source.replaceAll("~/.local/mini-proxy", "~/../mini-proxy")],
    ["empty services", 'schema_version = 1\nid = "proxy"\n[services]\n'],
    [
      "owned pattern",
      source.replace(
        'label = "local.miniarchipel.proxy"',
        'label_pattern = "local.miniarchipel.*"',
      ),
    ],
  ])("rejects %s", (_reason, text) => {
    expect(() => parseManifest(text, "proxy")).toThrow();
  });

  it("rejects catalog alias and service collisions", () => {
    const proxy = parseManifest(source, "proxy");
    expect(() => {
      validateManifests([proxy, { ...proxy, id: "other" }]);
    }).toThrow("alias");
    expect(() => {
      validateManifests([proxy, { ...proxy, id: "other", legacy_ids: [] }]);
    }).toThrow("service label");
    expect(() => registerPlugins([{ ...first, id: "not-installed" }])).toThrow(
      "Missing or invalid plugin manifest",
    );
  });
});
