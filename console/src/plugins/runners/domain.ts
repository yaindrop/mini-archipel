import { defaultTranslate, type Translate } from "../../messages.ts";
import type { Host, Fleet } from "../../contracts.ts";
import { stale } from "../../domain.ts";
import { readEnvelope } from "../contracts.ts";
import {
  AgentDataSchema,
  ConsoleDataSchema,
  type Runner,
  type GitHubRunner,
} from "./contracts.ts";
export function runnerState(
  host: Host,
  runner: Runner,
  remoteRunners: GitHubRunner[] = [],
  now = Date.now(),
): "unknown" | "busy" | "stopped" | "connecting" | "ready" | "listening" {
  if (!current(host, now)) return "unknown";
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
export function consoleData(fleet: Fleet) {
  const parsed = ConsoleDataSchema.safeParse(fleet.plugins.runners?.data);
  return parsed.success
    ? parsed.data
    : {
        repositories: [],
      };
}
export function remoteFor(fleet: Fleet): GitHubRunner[] {
  const data = consoleData(fleet);
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
