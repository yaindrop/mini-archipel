import { defaultTranslate, type Translate } from "../../messages.ts";
import type { Host, Archipel } from "../../contracts.ts";
import { stale } from "../../domain.ts";
import { readEnvelope } from "../contracts.ts";
import {
  AgentDataSchema,
  ConsoleDataSchema,
  type Runner,
  type GitHubRunner,
} from "./contracts.ts";
const CONCLUSION = {
  passed: /*i18n*/ { id: "通过", message: "通过" },
  environment: /*i18n*/ { id: "环境失败", message: "环境失败" },
  check: /*i18n*/ { id: "项目检查失败", message: "项目检查失败" },
  infrastructure: /*i18n*/ { id: "基础设施故障", message: "基础设施故障" },
  interrupted: /*i18n*/ { id: "中断", message: "中断" },
  incomplete: /*i18n*/ { id: "未完成", message: "未完成" },
} as const;
const RECEIPT_MS = 120_000;

/** A finished success is only a receipt. Leave it up briefly, not on every later visit. */
export function showOperation(
  operation: { status: string; finished_at: number | null } | undefined,
  now: number,
) {
  if (!operation) return false;
  if (operation.status !== "completed") return true;
  return (
    operation.finished_at != null && now - operation.finished_at < RECEIPT_MS
  );
}

export function conclusionLabel(
  conclusion: string,
  translate: Translate = defaultTranslate,
) {
  const entry = (
    CONCLUSION as Record<
      string,
      (typeof CONCLUSION)[keyof typeof CONCLUSION] | undefined
    >
  )[conclusion];
  if (!entry) return conclusion;
  return translate(entry);
}
export function runnerState(
  host: Host,
  runner: Runner,
  remoteRunners: GitHubRunner[] = [],
  now = Date.now(),
):
  | "unknown"
  | "busy"
  | "stopped"
  | "connecting"
  | "ready"
  | "listening"
  | "paused"
  | "waiting" {
  if (!current(host, now)) return "unknown";
  const coordination = agentData(host)?.coordination;
  if (coordination?.enabled) {
    if (coordination.waiting.includes(runner.repo_dir)) return "waiting";
    if (coordination.paused.includes(runner.repo_dir)) return "paused";
  }
  const remote = matchingRemote(runner, remoteRunners);
  if (runner.worker_pid !== null || remote?.busy) return "busy";
  if (runner.listener_pid === null) return "stopped";
  if (remote?.status === "offline") return "connecting";
  return remote ? "ready" : "listening";
}
export function agentData(host: Host) {
  const envelope = readEnvelope(host, "runners");
  if (
    !envelope?.enabled ||
    envelope.version !== 2 ||
    envelope.status !== "ready"
  )
    return null;
  const parsed = AgentDataSchema.safeParse(envelope.data);
  return parsed.success ? parsed.data : null;
}
export function runnersFor(host: Host): Runner[] {
  return agentData(host)?.runners ?? [];
}
/** Active means the listener is running. The card shows active/total. */
export function runnerCounts(host: Host): { active: number; total: number } {
  const runners = runnersFor(host);
  return {
    active: runners.filter((runner) => runner.listener_pid !== null).length,
    total: runners.length,
  };
}
export function consoleData(archipel: Archipel) {
  const parsed = ConsoleDataSchema.safeParse(archipel.plugins.runners?.data);
  return parsed.success
    ? parsed.data
    : {
        repositories: [],
      };
}
export function remoteFor(archipel: Archipel): GitHubRunner[] {
  const data = consoleData(archipel);
  return data.repositories
    .filter((repo) => Date.now() - repo.lastTs < 90000)
    .flatMap((repo) => repo.remote);
}
export function matchingRemote(
  runner: Runner,
  remote: GitHubRunner[],
): GitHubRunner | undefined {
  return remote.find(
    (r) =>
      r.repo === runner.repo &&
      (runner.agent_id !== null
        ? r.id === runner.agent_id
        : r.name === runner.agent_name),
  );
}
export function repositoryGroups(
  hosts: Host[],
  translate: Translate = defaultTranslate,
) {
  const groups = new Map<
    string,
    {
      key: string;
      repo: string | null;
      label: string;
      rows: {
        host: Host;
        runner: Runner;
      }[];
    }
  >();
  for (const host of hosts)
    for (const runner of runnersFor(host)) {
      const key = runner.repo ?? `unknown:${host.name}:${runner.repo_dir}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          repo: runner.repo,
          label:
            runner.repo ??
            translate(
              /*i18n*/ {
                id: "未识别仓库 · {directory}",
                message: "未识别仓库 · {directory}",
                values: { directory: runner.repo_dir },
              },
            ),
          rows: [],
        };
        groups.set(key, group);
      }
      group.rows.push({
        host,
        runner,
      });
    }
  return [...groups.values()].toSorted((a, b) =>
    a.label.localeCompare(b.label),
  );
}
export function current(host: Host, now = Date.now()): boolean {
  const data = agentData(host),
    envelope = readEnvelope(host, "runners");
  return Boolean(
    data &&
    envelope &&
    !stale(host, now) &&
    now - envelope.ts < Math.max(15000, data.interval_ms * 3),
  );
}
