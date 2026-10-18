import { PluginViewSchema } from "./plugins/contracts.ts";
import { z } from "zod";
const number = z.number();
const bytes = number.nonnegative();
export const PointSchema = z.object({ ts: bytes, value: number });
export type Point = z.infer<typeof PointSchema>;
export interface ScanNode {
  root: string;
  class: string;
  bytes: number;
  children: ScanNode[];
  ts: number;
  duration_ms: number;
  partial: boolean;
  children_status:
    "unscanned" | "complete" | "partial" | "unreadable" | "excluded";
  error: string | null;
}
const ScanSchema: z.ZodType<ScanNode> = z.lazy(() =>
  z.object({
    root: z.string(),
    class: z.string(),
    bytes,
    children: z.array(ScanSchema),
    ts: bytes,
    duration_ms: bytes,
    partial: z.boolean(),
    children_status: z
      .enum(["unscanned", "complete", "partial", "unreadable", "excluded"])
      .default("unscanned"),
    error: z.string().nullable().default(null),
  }),
);
const DiskScanJobSchema = z.object({
  id: bytes,
  status: z.enum([
    "idle",
    "queued",
    "running",
    "cancelling",
    "completed",
    "cancelled",
    "failed",
    "interrupted",
  ]),
  requested_at: bytes,
  started_at: bytes.nullable(),
  finished_at: bytes.nullable(),
  current_root: z.string().nullable(),
  target: z.string().nullable().default(null),
  error: z.string().nullable(),
});
export const SnapshotSchema = z.object({
  agent: z.object({ version: z.string(), started_at: bytes, ts: bytes }),
  host: z
    .object({
      name: z.string(),
      model: z.string(),
      os: z.string(),
      arch: z.string(),
      cores: bytes,
      memory_bytes: bytes,
      uptime_s: bytes,
      load: z.array(number),
      ts: bytes,
    })
    .nullable(),
  sys: z
    .object({
      cpu: z.object({ usage_pct: number, cores: z.array(number) }),
      mem: z.object({
        total_bytes: bytes,
        used_bytes: bytes,
        available_bytes: bytes,
        swap_total_bytes: bytes,
        swap_used_bytes: bytes,
      }),
      disks: z.array(
        z.object({
          mount: z.string(),
          fs: z.string(),
          total_bytes: bytes,
          available_bytes: bytes,
        }),
      ),
      procs: z.array(
        z.object({
          pid: bytes,
          name: z.string(),
          cpu_pct: number,
          mem_bytes: bytes,
        }),
      ),
      ts: bytes,
    })
    .nullable(),
  macmon: z
    .object({
      e_cluster_mhz: number.nullable(),
      e_cluster_pct: number.nullable(),
      p_cluster_mhz: number.nullable(),
      p_cluster_pct: number.nullable(),
      gpu_mhz: number.nullable(),
      gpu_pct: number.nullable(),
      cpu_power_w: number.nullable(),
      gpu_power_w: number.nullable(),
      package_power_w: number.nullable(),
      ts: bytes,
    })
    .nullable(),
  thermal: z
    .object({ state: z.number().int().min(0).max(3), ts: bytes })
    .nullable(),
  fan: z
    .object({
      ok: z.boolean().optional(),
      have_temp: z.boolean().optional(),
      temp: number.nullish(),
      rpm: number.nullish(),
      target: number.nullish(),
      forced: z.boolean().optional(),
      paused: z.boolean().optional(),
    })
    .nullable(),
  disk_scans: z.array(ScanSchema),
  disk_scan: DiskScanJobSchema,
  plugins: z.record(z.string(), z.unknown()).default({}),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;
export const NodeKindSchema = z.enum(["physical", "virtual"]);
const HostSchema = z.object({
  name: z.string(),
  kind: NodeKindSchema,
  identity: z.string(),
  online: z.boolean(),
  lastError: z.string().nullable(),
  lastTs: bytes,
  snapshot: SnapshotSchema.nullable(),
  history: z.record(z.string(), z.array(PointSchema)),
});
export type Host = z.infer<typeof HostSchema>;
export const FleetSchema = z.object({
  ts: bytes,
  hosts: z.array(HostSchema),
  plugins: z.record(z.string(), PluginViewSchema).default({}),
});
export type Fleet = z.infer<typeof FleetSchema>;
export const HistorySchema = z.object({
  host: z.string(),
  key: z.string(),
  points: z.array(PointSchema),
});
export const ConfigViewSchema = z.object({
  version: z.string(),
  hosts: z.array(z.object({ name: z.string(), url: z.string() })),
  pollIntervalMs: bytes,
});
export const SessionSchema = z.object({
  authenticated: z.boolean(),
  required: z.boolean(),
});
export const OkSchema = z.object({ ok: z.literal(true) });
