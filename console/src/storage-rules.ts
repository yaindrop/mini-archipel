import { z } from "zod";
const StorageClassSchema = z.enum([
  "system",
  "apps",
  "user",
  "reclaimable",
  "toolchain",
  "agentic",
  "library",
  "appdata",
]);
export const DirectoryRuleSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .max(4096)
    .refine(
      (path) =>
        (path === "~" || path.startsWith("~/") || path.startsWith("/")) &&
        !/[\u0000-\u001f\u007f]/u.test(path) &&
        !path.split("/").includes(".."),
    ),
  depth: z.number().int().min(0).max(4).nullable().optional(),
  class: StorageClassSchema.nullable().optional(),
});
const DiskRulesConfigSchema = z.strictObject({
  use_defaults: z.boolean(),
  rules: z.array(DirectoryRuleSchema).max(128),
});
export const DiskRulesUpdateSchema = z.strictObject({
  revision: z.string().min(1).max(128),
  config: DiskRulesConfigSchema,
});
export const DiskRulesViewSchema = z.object({
  revision: z.string(),
  home: z.string(),
  roots: z.array(z.string()),
  config: DiskRulesConfigSchema,
  defaults: z.array(DirectoryRuleSchema),
  plugins: z.array(z.object({ plugin: z.string(), path: z.string() })),
});
export type DirectoryRule = z.infer<typeof DirectoryRuleSchema>;
export type DiskRulesConfig = z.infer<typeof DiskRulesConfigSchema>;
export type DiskRulesView = z.infer<typeof DiskRulesViewSchema>;
export type DiskRulesUpdate = z.infer<typeof DiskRulesUpdateSchema>;
export function ruleKey(path: string, home: string): string {
  const expanded =
    path === "~" ? home : path.startsWith("~/") ? home + path.slice(1) : path;
  return (
    "/" +
    expanded
      .split("/")
      .filter((part) => part && part !== ".")
      .join("/")
  );
}
export interface RuleRow {
  key: string;
  path: string;
  base: DirectoryRule | null;
  override: DirectoryRule | null;
  origin: "default" | "plugin" | "custom";
  plugins: string[];
  depth: number | null;
  class: z.infer<typeof StorageClassSchema> | null;
}
/** Mirrors the Agent's exact-path precedence; null fields inherit independently. */
export function directoryRuleRows(
  view: DiskRulesView,
  config: DiskRulesConfig,
): RuleRow[] {
  const rows = new Map<string, RuleRow>();
  const insert = (
    rule: DirectoryRule,
    origin: RuleRow["origin"],
    plugin?: string,
  ) => {
    const key = ruleKey(rule.path, view.home);
    const row = rows.get(key);
    if (row && plugin) {
      row.plugins.push(plugin);
      return;
    }
    rows.set(key, {
      key,
      path:
        rule.path === view.home
          ? "~"
          : rule.path.startsWith(view.home + "/")
            ? "~" + rule.path.slice(view.home.length)
            : rule.path,
      base: origin === "custom" ? null : rule,
      override: origin === "custom" ? rule : null,
      origin,
      plugins: plugin ? [plugin] : [],
      depth: rule.depth ?? null,
      class: rule.class ?? null,
    });
  };
  if (config.use_defaults)
    for (const rule of view.defaults) insert(rule, "default");
  for (const rule of view.plugins)
    insert({ path: rule.path, depth: 1, class: null }, "plugin", rule.plugin);
  for (const rule of config.rules) {
    const row = rows.get(ruleKey(rule.path, view.home));
    if (!row) insert(rule, "custom");
    else {
      row.override = rule;
      row.depth = rule.depth ?? row.depth;
      row.class = rule.class ?? row.class;
    }
  }
  return [...rows.values()].sort((a, b) => a.path.localeCompare(b.path));
}
