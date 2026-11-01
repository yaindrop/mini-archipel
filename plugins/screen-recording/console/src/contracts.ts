import { z } from "zod";
const Target = z.number().int().min(1).max(4294967295);
const RequestId = z.uuid();
export const StartSchema = z
  .strictObject({
    request_id: RequestId,
    window: Target.optional(),
    display: Target.optional(),
    duration: z.number().min(0.1).max(86400),
    tail: z.number().min(0).max(30).optional(),
    pointer_source: z.literal("native").optional(),
  })
  .refine((v) => v.window == null || v.display == null);
export const ReplySchema = z.looseObject({
  schemaVersion: z.literal(1),
  ok: z.boolean(),
  code: z.string(),
  message: z.string(),
  appName: z.string().optional(),
  appPath: z.string().optional(),
  state: z.string().optional(),
  output: z.string().optional(),
  pointerOutput: z.string().optional(),
  durationSeconds: z.number().optional(),
  bytes: z.number().optional(),
  activeAction: z.string().optional(),
  windows: z
    .array(
      z.object({
        id: Target,
        bundleID: z.string(),
        title: z.string(),
        pid: z.number().int().optional(),
        onScreen: z.boolean().optional(),
        frame: z
          .object({
            x: z.number(),
            y: z.number(),
            width: z.number(),
            height: z.number(),
          })
          .optional(),
      }),
    )
    .optional(),
  displays: z
    .array(
      z.object({
        id: Target,
        width: z.number(),
        height: z.number(),
        main: z.boolean(),
      }),
    )
    .optional(),
});
export type RecorderReply = z.infer<typeof ReplySchema>;
const PermissionSchema = z.object({
  status: z.enum(["unchecked", "required", "waiting", "verified", "error"]),
  checked_at: z.number().nullable(),
  requested_at: z.number().nullable(),
  message: z.string().nullable(),
});
export const DataSchema = z.object({
  permissions: z.object({ screen: PermissionSchema, input: PermissionSchema }),
  availability: z.enum(["ready", "not_installed", "unsupported", "error"]),
  control_allowed: z.boolean(),
  interval_ms: z.number().int().min(1000).max(60000),
  output_directory: z.string(),
  backups: z.array(z.string()).default([]),
  package_available: z.boolean(),
  recorder: ReplySchema.nullable(),
  error: z.string().nullable(),
});
const host = z.string().min(1).max(128);
export const ActionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    host,
    action: z.literal("snapshot"),
    request_id: RequestId,
    recording_id: RequestId,
  }),
  z.strictObject({
    host,
    action: z.enum([
      "status",
      "doctor",
      "pointer-doctor",
      "windows",
      "displays",
      "stop",
      "install",
      "upgrade",
    ]),
  }),
  z.strictObject({
    host,
    action: z.enum(["authorize", "pointer-authorize"]),
    interactive: z.literal(true),
  }),
  z.strictObject({ host, action: z.literal("start"), request: StartSchema }),
  z.strictObject({
    host,
    action: z.literal("rollback"),
    backup: z
      .string()
      .startsWith("/")
      .max(4096)
      .refine((s) => !s.includes("\0")),
  }),
  z.strictObject({
    host,
    action: z.literal("artifact"),
    recording_id: RequestId,
    kind: z.enum(["video", "pointer", "snapshot"]),
    offset: z
      .number()
      .int()
      .min(0)
      .max(512 * 1024 * 1024)
      .optional(),
  }),
]);
export const ArtifactSchema = z.object({
  ok: z.literal(true),
  name: z.string(),
  mime: z.enum(["video/mp4", "application/json", "image/png"]),
  encoding: z.literal("hex"),
  data: z
    .string()
    .max(2 * 1024 * 1024)
    .regex(/^[0-9a-f]*$/)
    .refine((s) => s.length % 2 === 0),
  offset: z.number().int().min(0),
  next_offset: z.number().int().min(0),
  total_bytes: z.number().int().positive(),
});
export function readonlyAction(action: string) {
  return [
    "status",
    "doctor",
    "pointer-doctor",
    "windows",
    "displays",
    "artifact",
  ].includes(action);
}
