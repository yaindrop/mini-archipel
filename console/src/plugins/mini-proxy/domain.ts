import type { Host } from "../../contracts.ts";
import { readEnvelope } from "../contracts.ts";
import { AgentDataSchema, type AgentData } from "./contracts.ts";

export function proxyData(host: Host): AgentData | null {
  const envelope = readEnvelope(host, "mini-proxy");
  if (
    !envelope?.enabled ||
    envelope.version !== 1 ||
    envelope.status !== "ready"
  )
    return null;
  const parsed = AgentDataSchema.safeParse(envelope.data);
  return parsed.success ? parsed.data : null;
}

export function proxyEnabled(host: Host): boolean {
  return readEnvelope(host, "mini-proxy")?.enabled ?? false;
}
