import { DataSchema, type FanState, type Policy } from "./contracts.ts";
import { readEnvelope } from "../../../../console/src/plugins/contracts.ts";
import { stale } from "../../../../console/src/domain.ts";
import type { Host } from "../../../../console/src/contracts.ts";
export function withProtectionTemperature(
  policy: Policy,
  temperature: number,
): Policy {
  const critical = Math.max(
    40,
    Math.min(100, temperature),
    (policy.curve.at(-2)?.t ?? 0) + 1,
  );
  return {
    ...policy,
    critical_temp: critical,
    curve: policy.curve.map((p, i) =>
      i === policy.curve.length - 1 ? { t: critical, rpm: policy.max_rpm } : p,
    ),
  };
}
export function fanData(host: Host) {
  const envelope = readEnvelope(host, "fan-control");
  if (
    !envelope?.enabled ||
    envelope.version !== 1 ||
    envelope.status !== "ready"
  )
    return null;
  const result = DataSchema.safeParse(envelope.data);
  return result.success ? result.data : null;
}
export function readyState(host: Host): FanState | null {
  const data = fanData(host);
  return data?.availability === "ready" ? data : null;
}
const RECEIPT_MS = 120_000;

/** A cancelled or completed fan job is a receipt. Failures and unrestored jobs stay. */
export function showFanReceipt(
  job:
    | {
        status: string;
        error: string | null;
        finished_at: number | null;
        restored: boolean | null;
      }
    | undefined,
  now: number,
) {
  if (!job?.error) return false;
  if (job.restored === false) return true;
  if (job.status === "failed" || job.status === "interrupted") return true;
  if (job.status === "cancelled" || job.status === "completed")
    return job.finished_at != null && now - job.finished_at < RECEIPT_MS;
  return true;
}

export function activeJob(state: FanState) {
  return state.jobs.findLast((job) =>
    ["queued", "running", "cancelling", "restoring"].includes(job.status),
  );
}
export function controllable(host: Host, state: FanState, now = Date.now()) {
  return (
    !stale(host, now) &&
    state.control_allowed &&
    now - state.sampled_at < 15000 &&
    !state.telemetry_error
  );
}
