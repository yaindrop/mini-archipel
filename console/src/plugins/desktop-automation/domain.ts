import type { Host } from "../../contracts.ts";
import { stale } from "../../domain.ts";
import { readEnvelope } from "../contracts.ts";
import { DataSchema, type DesktopJob } from "./contracts.ts";

export function desktopData(host: Host) {
  const envelope = readEnvelope(host, "desktop-automation");
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
    envelope = readEnvelope(host, "desktop-automation");
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
