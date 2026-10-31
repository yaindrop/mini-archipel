import { useLingui as useLinguiMacro } from "@lingui/react/macro";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { refreshArchipel } from "../../web/useArchipel.ts";
import { App, Button, Empty, Table, Tag, Tooltip } from "antd";
import type { TableColumnsType } from "antd";
import { Activity, ArrowLeftRight, ShieldCheck } from "lucide-react";
import type { Archipel, Host } from "../../contracts.ts";
import { displayName, stale } from "../../domain.ts";
import { api } from "../../web/api.ts";
import { NodePager, PageTitle, Section } from "../../web/ui.tsx";
import { ActionReplySchema } from "./contracts.ts";
import { checkNodes, nodeDelay, proxyData, proxyEnabled } from "./domain.ts";

const hostLanes = new Map<string, Promise<unknown>>();

function enqueueHost<T>(host: string, job: () => Promise<T>): Promise<T> {
  const previous = hostLanes.get(host) ?? Promise.resolve();
  const run = previous.then(job, job);
  hostLanes.set(
    host,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

function AvailabilityTag({
  availability,
}: {
  availability: string | undefined;
}) {
  const { t } = useLinguiMacro();
  switch (availability) {
    case "ready":
      return <Tag color="green">{t`出口正常`}</Tag>;
    case "degraded":
      return <Tag color="orange">{t`出口受阻`}</Tag>;
    case "service_down":
      return <Tag color="red">{t`服务停止`}</Tag>;
    case "not_installed":
      return <Tag color="default">{t`未安装`}</Tag>;
    default:
      return <Tag>{t`状态待上报`}</Tag>;
  }
}

function HostProxy({ host, now }: { host: Host; now: number }) {
  const { t } = useLinguiMacro();
  const { message: feedback, modal } = App.useApp();
  const client = useQueryClient();
  const data = proxyData(host);
  const online = !stale(host, now);
  const exitDelay =
    data?.current_node != null
      ? nodeDelay(data.health[data.current_node])
      : null;
  const switchNode = useMutation({
    mutationFn: (node: string) =>
      api.pluginAction(
        "mini-proxy",
        "switch",
        {
          host: host.name,
          node,
        },
        ActionReplySchema,
      ),
    onSuccess: async (reply) => {
      await refreshArchipel(client);
      if (reply.ok) void feedback.success(t`切换请求已完成，出口已验证`);
      else void feedback.warning(t`节点检查未通过，请查看详情`);
    },
    onError: (error) => {
      void feedback.error(
        error instanceof Error ? error.message : String(error),
      );
    },
  });
  const check = useMutation({
    mutationFn: (node: string) =>
      enqueueHost(host.name, () =>
        api.pluginAction(
          "mini-proxy",
          "check",
          {
            host: host.name,
            node,
          },
          ActionReplySchema,
        ),
      ),
    onSuccess: async (reply: { ok: boolean }) => {
      await refreshArchipel(client);
      if (reply.ok) void feedback.success(t`节点检查通过`);
      else void feedback.warning(t`节点检查未通过，请查看详情`);
    },
    onError: (error) => {
      void feedback.error(
        error instanceof Error ? error.message : String(error),
      );
    },
  });
  const busy = switchNode.isPending || check.isPending;
  const columns: TableColumnsType<string> = [
    {
      title: t`节点`,
      key: "node",
      render: (_value, node) => (
        <span className="mini-proxy-node">
          <span className="mini-proxy-node-name">{node}</span>
          {data?.current_node === node ? (
            <Tag color="blue">{t`当前出口`}</Tag>
          ) : null}
        </span>
      ),
    },
    {
      title: t`延迟`,
      key: "health",
      width: 88,
      align: "end",
      render: (_value, node) => {
        const delay = nodeDelay(data?.health[node]);
        if (delay == null) return <Tag>{t`未测试`}</Tag>;
        return (
          <span
            className={
              delay < 0 ? "mini-proxy-delay-bad" : "mini-proxy-delay-ok"
            }
          >
            {delay}
          </span>
        );
      },
    },
    {
      title: t`操作`,
      key: "actions",
      width: 260,
      align: "end",
      render: (_value, node) => {
        const isCurrent = data?.current_node === node;
        const control = data?.control_allowed ?? false;
        const switchButton = (
          <Button
            size="small"
            icon={<ArrowLeftRight size={14} />}
            loading={switchNode.isPending && switchNode.variables === node}
            disabled={busy || !online || isCurrent || !control}
            onClick={() => {
              modal.confirm({
                title: t`切换出口节点`,
                content: t`将 ${node} 设为该节点的出境出口；切换会先试跑验证，失败自动回滚。`,
                okText: t`切换`,
                cancelText: t`取消`,
                onOk: () => {
                  void switchNode.mutateAsync(node);
                },
              });
            }}
          >
            {t`切换到此`}
          </Button>
        );
        return (
          <span className="mini-proxy-actions">
            <Button
              size="small"
              icon={<Activity size={14} />}
              loading={check.isPending && check.variables === node}
              disabled={busy || !online}
              onClick={() => {
                check.mutate(node);
              }}
            >
              {t`测速检查`}
            </Button>
            {control ? (
              switchButton
            ) : (
              <Tooltip title={t`该节点未开启代理控制`}>{switchButton}</Tooltip>
            )}
          </span>
        );
      },
    },
  ];
  return (
    <div className="mini-proxy-host">
      <div className="mini-proxy-host-heading">
        <AvailabilityTag availability={data?.availability} />
        {data?.control_allowed ? (
          <Tag icon={<ShieldCheck size={12} />} color="geekblue">
            {t`允许控制`}
          </Tag>
        ) : null}
        {!online ? <Tag color="default">{t`离线`}</Tag> : null}
        {exitDelay != null && exitDelay >= 0 ? (
          <span className="mini-proxy-probe mini-proxy-delay-ok">
            {t`出口延迟`} {exitDelay}ms
          </span>
        ) : null}
      </div>
      {data && data.availability !== "ready" && data.probe.error ? (
        <div className="mini-proxy-probe-error">{data.probe.error}</div>
      ) : null}
      <Table
        className="mini-proxy-table"
        tableLayout="fixed"
        rowKey={(node) => node}
        columns={columns}
        dataSource={data?.nodes ?? []}
        pagination={false}
        size="small"
      />
    </div>
  );
}

export function MiniProxy({
  archipel,
  now,
}: {
  archipel: Archipel;
  now: number;
}) {
  const { t } = useLinguiMacro();
  const client = useQueryClient();
  const { message: feedback } = App.useApp();
  const [search, setSearch] = useSearchParams();
  const enabled = archipel.hosts.filter((item) => proxyEnabled(item));
  const host =
    enabled.find((item) => item.name === search.get("host")) ?? enabled[0];
  const [checkingHosts, setCheckingHosts] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const checking = host ? checkingHosts.has(host.name) : false;
  const runCheckAll = (item: Host) => {
    if (checkingHosts.has(item.name)) return;
    setCheckingHosts((current) => new Set(current).add(item.name));
    const finish = () => {
      setCheckingHosts((current) => {
        const next = new Set(current);
        next.delete(item.name);
        return next;
      });
    };
    void checkNodes(proxyData(item)?.nodes ?? [], (node) =>
      enqueueHost(item.name, () =>
        api.pluginAction(
          "mini-proxy",
          "check",
          { host: item.name, node },
          ActionReplySchema,
        ),
      ),
    )
      .then(async (failed) => {
        await refreshArchipel(client);
        if (failed === 0) void feedback.success(t`全部测速完成`);
        else void feedback.warning(t`${failed} 个出口未通过`);
      })
      .catch((error: unknown) => {
        void feedback.error(
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(finish);
  };
  return (
    <>
      <PageTitle
        eyebrow={t`NETWORK OPERATIONS`}
        title={t`代理出口`}
        description={t`各节点出境代理的出口状态、节点测速与受控切换；切换由节点侧先验证再生效。`}
      />
      <NodePager
        hosts={enabled}
        now={now}
        selected={host?.name}
        onSelect={(name) => {
          setSearch({ host: name }, { replace: true });
        }}
        label={(item) => t`选择 ${displayName(item)}`}
        mark={(item) =>
          checkingHosts.has(item.name) ? (
            <Tag color="processing">{t`测速中`}</Tag>
          ) : null
        }
        summary={(item) => {
          const data = proxyData(item);
          const delay =
            data?.current_node != null
              ? nodeDelay(data.health[data.current_node])
              : null;
          const shown =
            delay != null && delay >= 0 ? `${String(delay)} ms` : "—";
          const availability =
            data?.availability === "ready"
              ? t`出口正常`
              : data?.availability === "service_down"
                ? t`服务停止`
                : data?.availability === "degraded"
                  ? t`出口受阻`
                  : t`状态待上报`;
          return (
            <>
              <span>{shown}</span>
              <small>
                {data?.current_node
                  ? `${data.current_node} · ${availability}`
                  : availability}
              </small>
            </>
          );
        }}
      />
      <Section
        title={host ? displayName(host) : t`节点出口`}
        subtitle={t`测速与 v2rayN 相同：经代理请求 generate_204 两次，间隔 100 毫秒，取较快的一次；没完成就是 -1。切换失败会回滚。`}
        action={
          <Button
            icon={<Activity size={14} />}
            loading={checking}
            disabled={
              checking ||
              !host ||
              stale(host, now) ||
              !proxyData(host)?.nodes.length
            }
            onClick={() => {
              if (host) runCheckAll(host);
            }}
          >
            {t`全部测速`}
          </Button>
        }
      >
        {host ? (
          <HostProxy key={host.name} host={host} now={now} />
        ) : (
          <Empty description={t`没有节点启用 mini-proxy 插件`} />
        )}
      </Section>
    </>
  );
}
