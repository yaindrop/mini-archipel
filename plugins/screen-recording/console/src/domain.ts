import type { Host } from "../../../../console/src/contracts.ts";
import { stale } from "../../../../console/src/domain.ts";
import { readEnvelope } from "../../../../console/src/plugins/contracts.ts";
import { DataSchema } from "./contracts.ts";
export function recorderData(host: Host) {
  const envelope = readEnvelope(host, "screen-recording");
  if (
    !envelope?.enabled ||
    envelope.version !== 1 ||
    envelope.status !== "ready"
  )
    return null;
  const data = DataSchema.safeParse(envelope.data);
  return data.success ? data.data : null;
}
export function recorderCurrent(host: Host, now = Date.now()) {
  const data = recorderData(host),
    envelope = readEnvelope(host, "screen-recording");
  return Boolean(
    data &&
    envelope &&
    !stale(host, now) &&
    now - envelope.ts < Math.max(15000, data.interval_ms * 3),
  );
}
export function recordingId(path: string | undefined) {
  const name = path?.split("/").at(-1);
  return name &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.mp4$/i.test(name)
    ? name.slice(0, -4)
    : null;
}
