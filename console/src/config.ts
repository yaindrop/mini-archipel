import { readFileSync } from "node:fs";

export interface HostConfig {
  name: string;
  url: string;
  token: string;
}

export interface ConsoleConfig {
  bind: string;
  /** Shared secret for dashboard API/WebSocket access. */
  uiToken: string;
  /** SQLite database path. */
  dbPath: string;
  hosts: HostConfig[];
  /** Optional GitHub token (repo scope) enabling runner/job enrichment. */
  githubToken?: string;
  /** Repository for runner enrichment, e.g. "yaindrop/flow-bit". */
  githubRepo?: string;
}

export function loadConfig(path: string): ConsoleConfig {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw.hosts) || raw.hosts.length === 0) {
    throw new Error("console config needs at least one agent host");
  }
  for (const host of raw.hosts) {
    if (!host.name || !host.url || !host.token) {
      throw new Error("each host needs name, url and token");
    }
  }
  return {
    bind: raw.bind ?? "127.0.0.1:9100",
    uiToken: raw.uiToken ?? "",
    dbPath: raw.dbPath ?? "console.db",
    hosts: raw.hosts,
  };
}
