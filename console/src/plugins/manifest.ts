import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { z } from "zod";
import type { PluginDefinition } from "./runtime.ts";

const idSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const labelSchema = z.string().regex(/^[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*$/);
const ownerSchema = z.enum(["plugin", "external"]);
const pathSchema = z.string().refine((value) => {
  const relative = value.startsWith("~/") ? value.slice(2) : value.slice(1);
  return (
    (value.startsWith("~/") || value.startsWith("/")) &&
    !/[\x00-\x1f\x7f$`*]/.test(value) &&
    relative
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}, "Expected an absolute or home-relative path without traversal");
const legacyPaths = z.array(pathSchema).min(1).optional();
const serviceSchema = z
  .strictObject({
    label: labelSchema.optional(),
    label_pattern: z
      .string()
      .regex(/^[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*\.\*$/)
      .optional(),
    legacy_labels: z.array(labelSchema).min(1).optional(),
    domain: z.enum(["gui", "system"]),
    owner: ownerSchema,
  })
  .refine(
    (service) =>
      (service.label !== undefined) !== (service.label_pattern !== undefined) &&
      (service.label_pattern === undefined ||
        (service.owner === "external" &&
          service.legacy_labels === undefined)) &&
      (service.owner !== "plugin" ||
        service.label?.startsWith("local.miniarchipel.")),
    "Services require one label; patterns belong to external services",
  );
const resourceSchema = z.strictObject({
  path: pathSchema,
  legacy_paths: legacyPaths,
  kind: z.enum(["program", "state", "backup", "log", "app", "socket"]),
  owner: ownerSchema,
  migration: z.enum(["move", "fixed"]),
});
const commandSchema = z.strictObject({
  path: pathSchema,
  target: pathSchema.optional(),
  legacy_paths: legacyPaths,
  owner: ownerSchema,
});
function resourceTable<T extends z.ZodType>(schema: T) {
  return z
    .record(z.string().regex(/^[a-z][a-z0-9_]*$/), schema)
    .refine(
      (table) => Object.keys(table).length > 0,
      "Omit empty resource tables",
    )
    .optional();
}
const manifestSchema = z.strictObject({
  schema_version: z.literal(1),
  id: idSchema,
  legacy_ids: z.array(idSchema).min(1).optional(),
  bundle_id: labelSchema.optional(),
  services: resourceTable(serviceSchema),
  paths: resourceTable(resourceSchema),
  commands: resourceTable(commandSchema),
});
export type PluginManifest = z.infer<typeof manifestSchema>;

function unique(values: string[], description: string) {
  if (new Set(values).size !== values.length)
    throw new Error(`Duplicate ${description}`);
}

export function parseManifest(
  source: string,
  expectedId: string,
): PluginManifest {
  const manifest = manifestSchema.parse(parse(source));
  if (manifest.id !== expectedId)
    throw new Error("Manifest and plugin ID differ");
  unique([manifest.id, ...(manifest.legacy_ids ?? [])], "plugin alias");
  for (const resource of Object.values(manifest.paths ?? {})) {
    unique([resource.path, ...(resource.legacy_paths ?? [])], "resource path");
    if (resource.migration === "fixed") continue;
    const roots: Record<string, string> = {
      program: `~/.local/libexec/mini-archipel/${manifest.id}`,
      state: `~/.local/share/mini-archipel/${manifest.id}`,
      backup: `~/.local/share/mini-archipel/${manifest.id}`,
      log: `~/Library/Logs/MiniArchipel/${manifest.id}`,
    };
    const root = roots[resource.kind];
    if (
      resource.owner !== "plugin" ||
      root === undefined ||
      (resource.path !== root && !resource.path.startsWith(root + "/"))
    )
      throw new Error(
        "Movable resources must use their owned canonical directory",
      );
  }
  for (const command of Object.values(manifest.commands ?? {}))
    unique([command.path, ...(command.legacy_paths ?? [])], "command path");
  return manifest;
}

export function validateManifests(manifests: PluginManifest[]) {
  unique(
    manifests.flatMap((manifest) => [
      manifest.id,
      ...(manifest.legacy_ids ?? []),
    ]),
    "registered plugin ID or alias",
  );
  unique(
    manifests.flatMap((manifest) =>
      Object.values(manifest.services ?? {}).flatMap((service) =>
        [
          service.label ?? service.label_pattern,
          ...(service.legacy_labels ?? []),
        ]
          .filter((label) => label !== undefined)
          .map((label) => `${service.domain}/${label}`),
      ),
    ),
    "registered service label",
  );
}

export function manifestUrl(id: string): URL {
  idSchema.parse(id);
  return new URL(
    import.meta.url.endsWith(".ts")
      ? `../../../plugins/${id}/manifest.toml`
      : `./manifests/${id}.toml`,
    import.meta.url,
  );
}

export function registerPlugins(definitions: PluginDefinition[]) {
  const plugins = definitions.map((definition) => {
    let manifest: PluginManifest;
    try {
      manifest = parseManifest(
        readFileSync(manifestUrl(definition.id), "utf8"),
        definition.id,
      );
    } catch {
      throw new Error(`Missing or invalid plugin manifest: ${definition.id}`);
    }
    return { ...definition, manifest, legacyIds: manifest.legacy_ids ?? [] };
  });
  validateManifests(plugins.map((plugin) => plugin.manifest));
  return plugins;
}
