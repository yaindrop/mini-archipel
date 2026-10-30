import { z } from "zod";

const RequestId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
const common = {
  request_id: RequestId,
  timeout: z.number().int().min(1).max(900).optional(),
};
export const JobRequestSchema = z
  .discriminatedUnion("operation", [
    z.strictObject({ ...common, operation: z.literal("doctor") }),
    z.strictObject({
      ...common,
      operation: z.literal("permissions"),
      permission: z.enum(["accessibility", "automation"]),
    }),
    z.strictObject({
      ...common,
      operation: z.literal("chat"),
      app: z.enum(["codex", "zcode"]),
      mode: z.enum(["send", "new", "read", "probe", "recover"]),
      target: z.string().min(1).max(160).optional(),
      message: z.string().min(1).max(64000).optional(),
      original_request_id: RequestId.optional(),
    }),
    z.strictObject({
      ...common,
      operation: z.literal("script"),
      mode: z.enum(["run", "exec"]),
      path: z
        .string()
        .startsWith("/")
        .max(4096)
        .refine((s) => !s.includes("\0")),
      arguments: z
        .array(
          z
            .string()
            .max(8000)
            .refine((s) => !s.includes("\0")),
        )
        .max(100)
        .optional(),
    }),
  ])
  .superRefine((request, ctx) => {
    if (request.operation !== "chat") return;
    const invalid =
      (request.mode === "new" && request.app !== "zcode") ||
      (["new", "send"].includes(request.mode) && !request.message?.trim()) ||
      (request.mode === "recover" && !request.original_request_id) ||
      (!["new", "recover"].includes(request.mode) && !request.target);
    if (invalid)
      ctx.addIssue({
        code: "custom",
        message: "Missing chat target or message",
      });
  });
export type JobRequest = z.infer<typeof JobRequestSchema>;
const JobSchema = z.object({
  id: RequestId,
  operation: z.enum(["doctor", "permissions", "chat", "script"]),
  status: z.enum([
    "queued",
    "running",
    "waiting_user",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
    "needs_user",
  ]),
  created_at: z.number(),
  updated_at: z.number(),
  error: z.string().nullable(),
  result: z.unknown().optional(),
});
export type DesktopJob = z.infer<typeof JobSchema>;
const ToolkitSchema = z.object({
  version: z.literal(1),
  installed: z.boolean(),
  apps: z.object({ codex: z.boolean(), zcode: z.boolean() }),
  permissions: z
    .object({
      accessibility: z.boolean(),
      automation: z.boolean().nullable(),
      checked_at: z.number(),
      screen_locked: z.boolean().nullable().optional(),
      console_session: z.boolean().optional(),
    })
    .nullable(),
  jobs: z.array(JobSchema),
  paused: z.boolean(),
  desktop_busy: z.boolean(),
  capabilities: z.array(z.string()),
});
export const DataSchema = z.object({
  availability: z.enum(["ready", "missing", "unsupported"]),
  control_allowed: z.boolean(),
  scripts_allowed: z.boolean(),
  interval_ms: z.number(),
  toolkit: ToolkitSchema.nullable(),
  error: z.string().nullable(),
});
export type DesktopData = z.infer<typeof DataSchema>;
export const ActionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("submit"),
    host: z.string().min(1),
    request: JobRequestSchema,
  }),
  z.strictObject({
    action: z.enum(["get", "cancel"]),
    host: z.string().min(1),
    request_id: RequestId,
  }),
  z.strictObject({
    action: z.enum(["status", "diagnostics"]),
    host: z.string().min(1),
  }),
  z.strictObject({
    action: z.literal("coordinate"),
    host: z.string().min(1),
    paused: z.boolean(),
  }),
]);
export const JobReplySchema = z.object({
  ok: z.literal(true),
  job: JobSchema,
  reused: z.boolean().optional(),
});
export const StateReplySchema = z.object({
  ok: z.literal(true),
  data: ToolkitSchema,
});
export const DiagnosticReplySchema = z.object({
  ok: z.literal(true),
  report: z.record(z.string(), z.unknown()),
});
