import { useLingui } from "@lingui/react";
import { useLingui as useLinguiMacro } from "@lingui/react/macro";
import { remoteText } from "../../messages.ts";
import { refreshFleet } from "../../web/useFleet.ts";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Empty,
  Modal,
  Space,
  Tag,
  Tabs,
  Tooltip,
  Typography,
} from "antd";
import { Check, CirclePause, GitBranch, Play, Terminal } from "lucide-react";
import type { Fleet, Host } from "../../contracts.ts";
import type { Runner, GitHubRunner, RepositoryState } from "./contracts.ts";
import {
  agentData,
  consoleData,
  runnersFor,
  remoteFor,
  current,
  runnerState,
  matchingRemote,
  repositoryGroups,
} from "./domain.ts";
import { RunnerStatus } from "./status.tsx";
import { readEnvelope } from "../contracts.ts";
import { displayName, formatBytes } from "../../domain.ts";
import { api, message } from "../../web/api.ts";
import { Metric, PageTitle, Section } from "../../web/ui.tsx";
export function RunnerList({
  hosts,
  now,
  repositories,
  remoteRunners,
  layout = "repositories",
}: {
  hosts: Host[];
  now: number;
  repositories: RepositoryState[];
  remoteRunners: GitHubRunner[];
  layout?: "repositories" | "node";
}) {
  const { _ } = useLingui();
  const { t } = useLinguiMacro();
  const [search, setSearch] = useSearchParams();
  const [confirm, setConfirm] = useState<{
      host: Host;
      runner: Runner;
      enable: boolean;
    } | null>(null),
    client = useQueryClient(),
    { message: feedback } = App.useApp();
  const mutation = useMutation({
    mutationFn: ({
      host,
      runner,
      enable,
    }: {
      host: Host;
      runner: Runner;
      enable: boolean;
    }) =>
      api.pluginAction("runners", "toggle", {
        host: host.name,
        repo: runner.repo,
        runner: runner.repo_dir,
        enable,
      }),
    onSuccess: async (_data, variables) => {
      await refreshFleet(client);
      void feedback.success(
        variables.enable
          ? t`${variables.runner.agent_name ?? variables.runner.repo_dir} 已启动接单`
          : t`${variables.runner.agent_name ?? variables.runner.repo_dir} 已停止接单`,
      );
      setConfirm(null);
    },
  });
  const groups = repositoryGroups(hosts, _),
    selected =
      groups.find((group) => group.key === search.get("repo")) ?? groups[0],
    rows = groups.flatMap((group) => group.rows);
  const unavailable = hosts.filter((host) => !agentData(host));
  if (!rows.length)
    return (
      <Empty
        description={
          unavailable.length
            ? t`节点 Runner 插件未启用、尚未就绪或数据版本不兼容，请在插件管理中检查。`
            : t`尚未发现 runner，节点上报安装信息后会自动显示。`
        }
      />
    );
  const items = groups.map((group) => {
    const github = repositories.find((repo) => repo.repo === group.repo);
    return {
      key: group.key,
      label: (
        <Space>
          <GitBranch size={15} />
          <span>{group.label}</span>
          {layout === "repositories" ? <Tag>{group.rows.length}</Tag> : null}
        </Space>
      ),
      children:
        layout === "node" || group.key === selected?.key ? (
          <>
            {unavailable.length ? (
              <Alert
                type="warning"
                showIcon
                title={t`${unavailable.map(displayName).join("、")}：Runner 插件数据不可用`}
                action={<Link to="/plugins">{t`管理插件`}</Link>}
              />
            ) : null}
            {!github ? (
              <Alert
                type="info"
                showIcon
                title={t`此仓库当前显示本地进程状态。接入 GitHub 后可核对远端在线与作业状态。`}
                action={<Link to="/connections">{t`查看连接`}</Link>}
              />
            ) : github.lastError ? (
              <Alert
                type="warning"
                showIcon
                title={remoteText(github.lastError, _)}
              />
            ) : null}
            <div className="runner-list">
              {group.rows.map(({ host, runner }) => {
                const status = runnerState(host, runner, remoteRunners, now),
                  enabled = runner.listener_pid !== null,
                  remote = matchingRemote(runner, remoteRunners),
                  disabled =
                    !runner.repo ||
                    status === "busy" ||
                    !current(host, now) ||
                    !agentData(host)?.control_allowed ||
                    mutation.isPending;
                return (
                  <Card
                    className="runner-card"
                    key={`${host.name}-${runner.repo_dir}`}
                    title={
                      <Space>
                        <span
                          className={`runner-glyph ${status === "busy" ? "runner-glyph-busy" : ""}`}
                        >
                          <Terminal size={20} />
                        </span>
                        <span className="runner-card-name">
                          <h3>{displayName(host)}</h3>
                          <Space size={8}>
                            <Link
                              to={`/nodes/${encodeURIComponent(host.name)}`}
                            >
                              {runner.agent_name ?? runner.repo_dir}
                            </Link>
                            <Typography.Text type="secondary">
                              #{runner.agent_id ?? "—"}
                            </Typography.Text>
                          </Space>
                        </span>
                      </Space>
                    }
                    extra={
                      <Space wrap>
                        <RunnerStatus
                          host={host}
                          runner={runner}
                          now={now}
                          remote={remoteRunners}
                        />
                        <Tooltip
                          title={
                            !runner.repo
                              ? t`未识别注册仓库，无法执行服务操作`
                              : status === "busy"
                                ? t`作业运行中，暂时不能切换`
                                : !current(host, now)
                                  ? t`节点数据过期，操作不可用`
                                  : !agentData(host)?.control_allowed
                                    ? t`此节点尚未授权 Runner 服务控制`
                                    : undefined
                          }
                        >
                          <Button
                            type={enabled ? "default" : "primary"}
                            disabled={disabled}
                            icon={
                              enabled ? (
                                <CirclePause size={15} />
                              ) : (
                                <Play size={15} />
                              )
                            }
                            onClick={() => {
                              mutation.reset();
                              setConfirm({
                                host,
                                runner,
                                enable: !enabled,
                              });
                            }}
                          >
                            {enabled ? t`停止接单` : t`启动接单`}
                          </Button>
                        </Tooltip>
                      </Space>
                    }
                  >
                    <Descriptions
                      column={{
                        xs: 2,
                        sm: 2,
                        md: 4,
                      }}
                      size="small"
                      layout="vertical"
                      items={[
                        {
                          key: "work",
                          label: t`工作区`,
                          children: (
                            <span className="num">
                              {formatBytes(runner.work_bytes)}
                            </span>
                          ),
                        },
                        {
                          key: "diag",
                          label: t`诊断日志`,
                          children: (
                            <Typography.Text
                              {...((runner.diag_bytes ?? 0) > 256 * 2 ** 20
                                ? {
                                    type: "warning" as const,
                                  }
                                : {})}
                              className="num"
                            >
                              {formatBytes(runner.diag_bytes)}
                              <small className="muted"> / 256 MiB</small>
                            </Typography.Text>
                          ),
                        },
                        {
                          key: "pid",
                          label: t`本地进程`,
                          children: (
                            <span className="num">
                              {runner.worker_pid !== null
                                ? `Worker ${String(runner.worker_pid)}`
                                : runner.listener_pid !== null
                                  ? `Listener ${String(runner.listener_pid)}`
                                  : t`未运行`}
                            </span>
                          ),
                        },
                        {
                          key: "github",
                          label: "GitHub",
                          children: remote
                            ? `${remote.status}${remote.busy ? " · busy" : ""}`
                            : t`未取得远端状态`,
                        },
                      ]}
                    />
                    {remote?.labels.length ? (
                      <Space size={[4, 4]} wrap className="runner-labels">
                        {remote.labels.map((label) => (
                          <Tag key={label.name}>{label.name}</Tag>
                        ))}
                      </Space>
                    ) : null}
                    <div className="runner-card-footer">
                      <code>{`~/runners/${runner.repo_dir}`}</code>
                      <Typography.Text type="secondary" className="runner-log">
                        {runner.diag_latest ?? t`暂无诊断日志`}
                      </Typography.Text>
                    </div>
                  </Card>
                );
              })}
            </div>
          </>
        ) : null,
    };
  });
  return (
    <>
      {layout === "node" ? (
        <div className="runner-node-repositories">
          {items.map((item) => (
            <section key={item.key}>
              <h3 className="runner-repository-heading">{item.label}</h3>
              {item.children}
            </section>
          ))}
        </div>
      ) : (
        <Tabs
          className="runner-repo-tabs"
          animated={false}
          activeKey={selected?.key ?? ""}
          onChange={(key) => {
            setConfirm(null);
            mutation.reset();
            const next = new URLSearchParams(search);
            next.set("repo", key);
            setSearch(next, { replace: true });
          }}
          items={items}
        />
      )}
      <Modal
        title={confirm?.enable ? t`启动接单` : t`停止接单`}
        open={confirm !== null}
        centered
        transitionName=""
        maskTransitionName=""
        destroyOnHidden
        confirmLoading={mutation.isPending}
        keyboard={!mutation.isPending}
        mask={{
          closable: !mutation.isPending,
        }}
        closable={!mutation.isPending}
        cancelText={t`取消`}
        okText={confirm?.enable ? t`确认启动` : t`确认停止`}
        okButtonProps={{
          danger: !confirm?.enable,
        }}
        cancelButtonProps={{
          disabled: mutation.isPending,
        }}
        onCancel={() => {
          if (!mutation.isPending) setConfirm(null);
        }}
        onOk={() => {
          if (confirm) mutation.mutate(confirm);
        }}
      >
        {confirm ? (
          <>
            <Typography.Paragraph>
              {confirm.enable
                ? t`启动后，该 runner 会连接 GitHub 并接受新的作业。`
                : t`停止后，该 runner 将停止接单，重启节点也不会自动恢复。现有工作区和注册信息会保留。`}
            </Typography.Paragraph>
            <div className="confirm-target">
              <Terminal size={20} />
              <span>
                <strong>
                  {confirm.runner.agent_name ?? confirm.runner.repo_dir}
                </strong>
                <Typography.Text type="secondary">
                  {displayName(confirm.host)} · {confirm.runner.repo}
                </Typography.Text>
              </span>
            </div>
          </>
        ) : null}
        {mutation.isError ? (
          <Alert
            type="error"
            showIcon
            title={message(mutation.error, _)}
            role="alert"
          />
        ) : null}
      </Modal>
    </>
  );
}
export function Runners({ fleet, now }: { fleet: Fleet; now: number }) {
  const { t } = useLinguiMacro();
  const remoteRunners = remoteFor(fleet);
  const rows = fleet.hosts.flatMap((host) =>
      runnersFor(host).map((runner) => ({
        host,
        runner,
      })),
    ),
    count = (state: string) =>
      rows.filter(
        ({ host, runner }) =>
          runnerState(host, runner, remoteRunners, now) === state,
      ).length;
  return (
    <>
      <PageTitle
        eyebrow={t`CI OPERATIONS`}
        title="Runners"
        description={t`统一管理接单进程，核对本地状态与 GitHub 连接。`}
      />
      <div className="metrics-row">
        <Metric
          label={t`已注册runner`}
          value={rows.length}
          detail={t`按仓库、节点分别注册`}
          icon={<Terminal size={18} />}
        />
        <Metric
          label={t`正在执行作业`}
          value={count("busy")}
          detail={t`运行中的作业受到启停保护`}
          icon={<Play size={18} />}
        />
        <Metric
          label={t`监听 / 可接单`}
          value={count("listening") + count("ready")}
          detail={t`已启动本地监听进程`}
          icon={<Check size={18} />}
        />
        <Metric
          label={t`已停止`}
          value={count("stopped")}
          detail={t`可在下方确认后恢复接单`}
          icon={<CirclePause size={18} />}
        />
      </div>
      <Section
        title={t`接单进程`}
        subtitle={t`执行操作前，工作台和节点都会重新检查作业状态。`}
      >
        <RunnerList
          hosts={fleet.hosts}
          now={now}
          repositories={consoleData(fleet).repositories}
          remoteRunners={remoteRunners}
        />
      </Section>
    </>
  );
}
export function NodePanel({
  fleet,
  host,
  now,
}: {
  fleet: Fleet;
  host: Host;
  now: number;
}) {
  const { t } = useLinguiMacro();
  return (
    <Section
      title={t`节点 Runners`}
      action={<Link to="/plugins">{t`管理插件`}</Link>}
    >
      {!readEnvelope(host, "runners")?.enabled ? (
        <Alert
          type="info"
          showIcon
          title={t`此节点的 Runner 插件未启用`}
          action={<Link to="/plugins">{t`启用插件`}</Link>}
        />
      ) : (
        <RunnerList
          hosts={[host]}
          layout="node"
          now={now}
          repositories={consoleData(fleet).repositories}
          remoteRunners={remoteFor(fleet)}
        />
      )}
    </Section>
  );
}
export function OverviewPanel({ fleet, now }: { fleet: Fleet; now: number }) {
  const { t } = useLinguiMacro();
  const rows = fleet.hosts.flatMap((host) =>
      runnersFor(host).map((runner) => ({
        host,
        runner,
      })),
    ),
    remote = remoteFor(fleet);
  const busy = rows.filter(
    ({ host, runner }) => runnerState(host, runner, remote, now) === "busy",
  ).length;
  return (
    <Section
      title="Runners"
      subtitle={t`插件提供的 CI 作业与接单状态`}
      action={<Link to="/runners">{t`管理接单进程 ↗`}</Link>}
    >
      <Space size="large" wrap>
        <Tag color="processing">{t`${busy} 个作业运行中`}</Tag>
        <Typography.Text>{t`已注册 ${rows.length} 个 Runner`}</Typography.Text>
        <Link to="/plugins">{t`插件设置`}</Link>
      </Space>
    </Section>
  );
}
export function ConnectionsPanel({ fleet }: { fleet: Fleet; now: number }) {
  const { _ } = useLingui();
  const { t } = useLinguiMacro();
  const { repositories } = consoleData(fleet);
  return (
    <Section title="GitHub Actions">
      <div className="github-connection">
        <Terminal size={28} />
        {repositories.length ? (
          repositories.map((repo) => (
            <div key={repo.repo} className="github-repository">
              <Typography.Text strong>{repo.repo}</Typography.Text>
              <Tag
                color={
                  repo.lastError
                    ? "warning"
                    : repo.lastTs
                      ? "success"
                      : "default"
                }
              >
                {repo.lastError
                  ? t`暂不可用`
                  : repo.lastTs
                    ? t`已接入`
                    : t`连接中`}
              </Tag>
              {repo.lastError ? (
                <Typography.Paragraph>
                  {remoteText(repo.lastError, _)}
                </Typography.Paragraph>
              ) : null}
            </div>
          ))
        ) : (
          <Typography.Paragraph>{t`当前展示本地 Runner 状态。GitHub 接入由 Runner 插件按仓库单独配置。`}</Typography.Paragraph>
        )}
        <Typography.Paragraph type="secondary">{t`仓库之间独立连接，连接失败不会影响其他仓库或本地 Runner 管理。`}</Typography.Paragraph>
      </div>
    </Section>
  );
}
