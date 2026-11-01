import type { Host } from "../../../../console/src/contracts.ts";
import { stale } from "../../../../console/src/domain.ts";
import { readEnvelope } from "../../../../console/src/plugins/contracts.ts";
import { DataSchema, type DesktopJob } from "./contracts.ts";

export function desktopData(host: Host) {
  const envelope = readEnvelope(host, "automation");
  if (
    !envelope?.enabled ||
    envelope.version !== 1 ||
    envelope.status !== "ready"
  )
    return null;
  const parsed = DataSchema.safeParse(envelope.data);
  return parsed.success ? parsed.data : null;
}
export function desktopCurrent(host: Host, now = Date.now()) {
  const data = desktopData(host),
    envelope = readEnvelope(host, "automation");
  return Boolean(
    data &&
    envelope &&
    !stale(host, now) &&
    now - envelope.ts < Math.max(15000, data.interval_ms * 3),
  );
}
export function active(job: DesktopJob) {
  return ["queued", "running", "waiting_user"].includes(job.status);
}
