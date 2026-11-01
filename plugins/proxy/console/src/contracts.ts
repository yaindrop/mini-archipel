import { z } from "zod";
export const PermissionsSchema = z.record(
  z.string(),
  z.object({
    status: z.enum([
      "unchecked",
      "required",
      "waiting",
      "verified",
      "error",
      "not-required",
    ]),
    checked_at: z.number().nullable(),
    requested_at: z.number().nullable(),
    message: z.string(),
    entrypoint: z.string().nullable().optional(),
  }),
);

const NodeName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);

export const ActionReplySchema = z.object({
  ok: z.boolean(),
});

export const AgentDataSchema = z.object({
  permissions: PermissionsSchema.optional(),
  availability: z.enum(["ready", "degraded", "service_down", "not_installed"]),
  current_node: NodeName.nullable(),
  nodes: z.array(NodeName),
  probe: z.object({
    status_code: z.number().int().nullable(),
    latency_ms: z.number().nullable(),
    error: z.string().nullable(),
    ts: z.number().nonnegative(),
  }),
  health: z.record(
    NodeName,
    z.object({
      ok: z.boolean(),
      check_ms: z.number().nonnegative(),
      ts: z.number().nonnegative(),
      detail: z.string(),
    }),
  ),
  control_allowed: z.boolean(),
  interval_ms: z.number().positive(),
});

export type AgentData = z.infer<typeof AgentDataSchema>;
