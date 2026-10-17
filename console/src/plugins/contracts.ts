import { z } from "zod";
import type { Host } from "../contracts.ts";

export const EnvelopeSchema = z.object({
  version: z.number().int().positive(),
  enabled: z.boolean(),
  status: z.enum(["disabled", "starting", "ready", "error"]),
  ts: z.number().nonnegative(),
  data: z.unknown(),
  error: z.string().nullable(),
});
export const PluginViewSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  version: z.string(),
  enabled: z.boolean(),
  data: z.unknown(),
  error: z.string().nullable(),
});
export type PluginView = z.infer<typeof PluginViewSchema>;
export function readEnvelope(host: Host, id: string) {
  const parsed = EnvelopeSchema.safeParse(host.snapshot?.plugins[id]);
  return parsed.success ? parsed.data : null;
}
