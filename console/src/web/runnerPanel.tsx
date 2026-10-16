import { useState } from "react";

interface RunnerView {
  repo_dir: string;
  agent_name: string | null;
  agent_id: number | null;
  listener_pid: number | null;
  worker_pid: number | null;
  work_bytes: number | null;
  diag_bytes: number | null;
  diag_latest: string | null;
}

interface GhRunner {
  id: number;
  name: string;
  status: string;
  busy: boolean;
  labels?: Array<{ name: string }>;
}

const fmtGiB = (bytes: number | null): string =>
  typeof bytes === "number" ? `${(bytes / 2 ** 30).toFixed(1)} GiB` : "—";
const fmtMiB = (bytes: number | null): string =>
  typeof bytes === "number" ? `${(bytes / 2 ** 20).toFixed(0)} MiB` : "—";

export function RunnerPanel({
  runners,
  ghRunners,
  host,
  token,
  workerBusy,
}: {
  runners: RunnerView[];
  ghRunners: GhRunner[] | null;
  host: string;
  token: string;
  workerBusy: boolean;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (runners.length === 0) return null;

  const setRunner = async (runnerName: string, enable: boolean) => {
    setPending(runnerName);
    setNotice(null);
    try {
      const response = await fetch("/api/runner/toggle", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : undefined),
        },
        body: JSON.stringify({ host, runner: runnerName, enable }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
      };
      if (response.ok && payload.ok) {
        setNotice(`${runnerName}: ${enable ? "已启用" : "已停用"}`);
      } else {
        setNotice(`${runnerName}: 失败 — ${payload.error ?? response.status}`);
      }
    } catch (error) {
      setNotice(
        `${runnerName}: 失败 — ${error instanceof Error ? error.message : error}`,
      );
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="runner-panel">
      <div className="panel-title">
        GitHub Runners
        {ghRunners === null ? (
          <span className="muted">
            {" "}
            · 未配置 GitHub token，无法显示 GitHub 侧在线/接单状态
          </span>
        ) : null}
        {notice ? <span className="muted"> · {notice}</span> : null}
      </div>
      {runners.map((runner) => {
        const remote = (ghRunners ?? []).find(
          (r) => r.name === runner.agent_name,
        );
        const busy = remote?.busy ?? runner.worker_pid !== null;
        const enabled = remote
          ? remote.status !== "offline"
          : runner.listener_pid !== null;
        const operating = pending === (runner.agent_name ?? runner.repo_dir);
        return (
          <div key={runner.repo_dir} className="runner-row">
            <span className="runner-dot">
              {runner.listener_pid ? (busy ? "🟡" : "🟢") : "⚪"}
            </span>
            <span className="runner-name">
              {runner.agent_name ?? runner.repo_dir}
            </span>
            <span className="runner-meta">
              #{runner.agent_id ?? "?"} · {runner.repo_dir}
            </span>
            <span className="runner-metric">
              _work {fmtGiB(runner.work_bytes)}
            </span>
            <span
              className={`runner-metric${(runner.diag_bytes ?? 0) > 256 * 2 ** 20 ? " warn" : ""}`}
            >
              _diag {fmtMiB(runner.diag_bytes)} / 256 MiB
            </span>
            <span className="runner-meta">
              {remote
                ? `GitHub: ${remote.status}${remote.busy ? " · busy" : ""}`
                : "GitHub: —"}
            </span>
            <button
              className="runner-toggle"
              disabled={operating || busy || workerBusy}
              onClick={() =>
                setRunner(runner.agent_name ?? runner.repo_dir, !enabled)
              }
              title={
                busy || workerBusy
                  ? "作业运行中，不能切换"
                  : enabled
                    ? "停用该 runner（重启后也不自动接单）"
                    : "启用该 runner（立即可接单）"
              }
            >
              {operating ? "…" : enabled ? "停用" : "启用"}
            </button>
            {runner.diag_latest ? (
              <span className="runner-meta muted">
                最新日志 {runner.diag_latest}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
