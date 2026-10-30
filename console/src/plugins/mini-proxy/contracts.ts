import { z } from "zod";

const NodeName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);

export const AgentDataSchema = z.object({
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
