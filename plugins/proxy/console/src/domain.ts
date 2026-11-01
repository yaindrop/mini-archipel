import type { Host } from "../../../../console/src/contracts.ts";
import { readEnvelope } from "../../../../console/src/plugins/contracts.ts";
import { AgentDataSchema, type AgentData } from "./contracts.ts";

/** Failed checks surface as -1. A passed check uses the generate_204 sample. */
export function nodeDelay(
  record: { ok: boolean; check_ms: number; detail?: string } | undefined,
): number | null {
  if (!record) return null;
  if (!record.ok) return -1;
  const sample = record.detail?.match(/(?:^|\n)latency_ms (\d+)/)?.[1];
  return sample == null ? record.check_ms : Number(sample);
}

/** Runs checks in order. Returns how many did not pass, including requests that threw. */
export async function checkNodes(
  nodes: readonly string[],
  check: (node: string) => Promise<{ ok: boolean }>,
): Promise<number> {
  let failed = 0;
  for (const node of nodes) {
    try {
      if (!(await check(node)).ok) failed += 1;
    } catch {
      failed += 1;
    }
  }
  return failed;
}

export function proxyData(host: Host): AgentData | null {
  const envelope = readEnvelope(host, "proxy");
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
  return readEnvelope(host, "proxy")?.enabled ?? false;
}
