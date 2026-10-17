import { z } from "zod";
const bytes = z.number().nonnegative();
const RepoSchema = z
  .string()
  .regex(/^[\w.-]+\/[\w.-]+$/)
  .refine((value) =>
    value.split("/").every((part) => part !== "." && part !== ".."),
  )
  .toLowerCase();
const RunnerSchema = z.object({
  repo_dir: z.string(),
  repo: RepoSchema.nullable(),
  agent_name: z.string().nullable(),
  agent_id: bytes.nullable(),
  labels: z.array(z.string()).default([]),
  work_folder: z.string().nullable().optional(),
  listener_pid: bytes.nullable(),
  worker_pid: bytes.nullable(),
  work_bytes: bytes.nullable(),
  diag_bytes: bytes.nullable(),
  diag_latest: z.string().nullable(),
  ts: bytes,
});
export type Runner = z.infer<typeof RunnerSchema>;
export const GitHubRunnerSchema = z.object({
  repo: RepoSchema,
  id: bytes,
  name: z.string(),
  status: z.enum(["online", "offline"]),
  busy: z.boolean(),
  labels: z.array(z.object({ name: z.string() })).default([]),
});
export type GitHubRunner = z.infer<typeof GitHubRunnerSchema>;

export const AgentDataSchema = z.object({
  runners: z.array(RunnerSchema),
  interval_ms: z.number().min(1000).max(60000),
  control_allowed: z.boolean(),
  coordination: z
    .object({
      available: z.boolean(),
      enabled: z.boolean(),
      active_repo: RepoSchema.nullable(),
      paused: z.array(z.string()),
      waiting: z.array(z.string()),
      error: z.string().nullable(),
    })
    .optional(),
});
const RepositoryStateSchema = z.object({
  repo: RepoSchema,
  lastTs: z.number(),
  lastError: z.string().nullable(),
  remote: z.array(GitHubRunnerSchema),
});
export type RepositoryState = z.infer<typeof RepositoryStateSchema>;
export const ConsoleDataSchema = z.object({
  repositories: z.array(RepositoryStateSchema),
});
export const OptionsSchema = z.strictObject({
  repositories: z
    .array(z.strictObject({ repo: RepoSchema, token: z.string().min(1) }))
    .refine(
      (repos) => new Set(repos.map((r) => r.repo)).size === repos.length,
      "repository names must be unique",
    )
    .default([]),
});
export const ToggleSchema = z.strictObject({
  repo: RepoSchema,
  runner: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[^/\\]+$/)
    .refine((value) => value !== "." && value !== ".."),
  enable: z.boolean(),
});
export const InterruptSchema = ToggleSchema.omit({ enable: true }).extend({
  worker_pid: z.number().int().positive(),
});
export const CoordinationSchema = z.strictObject({
  host: z.string().min(1),
  enable: z.boolean(),
});
