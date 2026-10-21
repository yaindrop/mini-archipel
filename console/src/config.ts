import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { NodeKindSchema } from "./contracts.ts";
const HostConfigSchema = z.object({
  name: z.string().min(1).max(100),
  kind: NodeKindSchema,
  identity: z.string().trim().max(200).default(""),
  url: z
    .url()
    .refine(
      (value) => /^https?:\/\//.test(value),
      "agent URL must use http(s)",
    ),
  token: z.string().min(1),
});
export const ConsoleConfigSchema = z.strictObject({
  bind: z
    .string()
    .regex(/^[\w.-]+:\d+$/)
    .default("127.0.0.1:9100"),
  tls: z
    .strictObject({
      certFile: z
        .string()
        .refine(isAbsolute, "use an absolute certificate path"),
      keyFile: z
        .string()
        .refine(isAbsolute, "use an absolute private-key path"),
    })
    .optional(),
  uiToken: z.string().default(""),
  dbPath: z.string().min(1).default("console.db"),
  hosts: z
    .array(HostConfigSchema)
    .min(1)
    .refine(
      (hosts) => new Set(hosts.map((h) => h.name)).size === hosts.length,
      "host names must be unique",
    ),
  plugins: z
    .record(
      z.string().regex(/^[a-z][a-z0-9-]*$/),
      z.strictObject({
        enabled: z.boolean().default(false),
        options: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .default({}),
});
export type ConsoleConfig = z.infer<typeof ConsoleConfigSchema>;
export function loadConfig(path: string): ConsoleConfig {
  const result = ConsoleConfigSchema.safeParse(
    JSON.parse(readFileSync(path, "utf8")) as unknown,
  );
  if (!result.success)
    throw new Error(
      `Invalid console configuration: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  return {
    ...result.data,
    dbPath: result.data.dbPath.startsWith("~/")
      ? join(homedir(), result.data.dbPath.slice(2))
      : result.data.dbPath,
  };
}

export function saveConfig(path: string, config: ConsoleConfig): void {
  const temp = `${path}.tmp-${String(process.pid)}`;
  try {
    writeFileSync(temp, JSON.stringify(config, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      /* No temporary file was created. */
    }
    throw error;
  }
}
