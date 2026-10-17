import { DataSchema, type FanState } from "./contracts.ts";
import { readEnvelope } from "../contracts.ts";
import { stale } from "../../domain.ts";
import type { Host } from "../../contracts.ts";
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
