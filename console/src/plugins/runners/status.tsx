import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Space, Tag } from "antd";
import type { Host } from "../../contracts.ts";
import type { Runner, GitHubRunner } from "./contracts.ts";
import { runnerState, current, runnersFor } from "./domain.ts";
const RUNNER_STATUS = {
  get unknown() {
    return {
      label: msg`状态未知`,
      color: "default",
    };
  },
  get busy() {
    return {
      label: msg`作业运行中`,
      color: "processing",
    };
  },
  get stopped() {
    return {
      label: msg`已停止接单`,
      color: "default",
    };
  },
  get connecting() {
    return {
      label: msg`正在连接 GitHub`,
      color: "warning",
    };
  },
  get ready() {
    return {
      label: msg`可接单`,
      color: "success",
    };
  },
  get listening() {
    return {
      label: msg`本地监听中`,
      color: "success",
    };
  },
} as const;
export function RunnerStatus({
  host,
  runner,
  now,
  remote = [],
}: {
  host: Host;
  runner: Runner;
  now: number;
  remote?: GitHubRunner[];
}) {
  const { _ } = useLingui();
  const state =
    RUNNER_STATUS[
      current(host, now) ? runnerState(host, runner, remote, now) : "unknown"
    ];
  return <Tag color={state.color}>{_(state.label)}</Tag>;
}
export function RunnerSummary({
  host,
  now,
  remote,
}: {
  host: Host;
  now: number;
  remote: GitHubRunner[];
}) {
  const { _ } = useLingui();
  const runners = runnersFor(host);
  if (!runners.length) return <>—</>;
  const counts = new Map<keyof typeof RUNNER_STATUS, number>();
  for (const runner of runners) {
    const state = runnerState(host, runner, remote, now);
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  return (
    <Space size={[4, 4]} wrap>
      {[...counts].map(([state, count]) => (
        <Tag key={state} color={RUNNER_STATUS[state].color}>
          {_(RUNNER_STATUS[state].label)}
          {runners.length > 1 ? ` ${String(count)}` : ""}
        </Tag>
      ))}
    </Space>
  );
}
