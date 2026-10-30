import { useLingui as useLinguiMacro } from "@lingui/react/macro";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { refreshArchipel } from "../../web/useArchipel.ts";
import { App, Button, Empty, Space, Table, Tag, Tooltip } from "antd";
import type { TableColumnsType } from "antd";
import { Activity, ArrowLeftRight, Globe, ShieldCheck } from "lucide-react";
import type { Archipel, Host } from "../../contracts.ts";
import { displayName, stale } from "../../domain.ts";
import { api } from "../../web/api.ts";
import { Metric, PageTitle, Section } from "../../web/ui.tsx";
import { proxyData, proxyEnabled } from "./domain.ts";

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
  const switchNode = useMutation({
    mutationFn: (node: string) =>
      api.pluginAction("mini-proxy", "switch", {
        host: host.name,
        node,
      }),
    onSuccess: async () => {
      await refreshArchipel(client);
      void feedback.success(t`切换请求已完成，出口已验证`);
    },
    onError: (error) => {
      void feedback.error(
        error instanceof Error ? error.message : String(error),
      );
    },
  });
  const check = useMutation({
    mutationFn: (node: string) =>
      api.pluginAction("mini-proxy", "check", {
        host: host.name,
        node,
      }),
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
        <Space>
          <span className="mini-proxy-node-name">{node}</span>
          {data?.current_node === node ? (
            <Tag color="blue">{t`当前出口`}</Tag>
          ) : null}
        </Space>
      ),
    },
    {
      title: t`上次检查`,
      key: "health",
      render: (_value, node) => {
        const record = data?.health[node];
        if (!record) return <Tag>{t`未测试`}</Tag>;
        return (
          <Space>
            <Tag color={record.ok ? "green" : "red"}>
              {record.ok ? t`通过` : t`失败`}
            </Tag>
            <span>
              {new Date(record.ts).toLocaleTimeString()} · {record.check_ms}ms
            </span>
          </Space>
        );
      },
    },
    {
      title: t`操作`,
      key: "actions",
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
          <Space>
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
          </Space>
        );
      },
    },
  ];
  return (
    <div className="mini-proxy-host">
      <div className="mini-proxy-host-heading">
        <span className="mini-proxy-host-name">{displayName(host)}</span>
        <AvailabilityTag availability={data?.availability} />
        {data?.control_allowed ? (
          <Tag icon={<ShieldCheck size={12} />} color="geekblue">
            {t`允许控制`}
          </Tag>
        ) : null}
        {!online ? <Tag color="default">{t`离线`}</Tag> : null}
        {data?.probe.latency_ms != null ? (
          <span className="mini-proxy-probe">
            {t`出口延迟`} {data.probe.latency_ms}ms
          </span>
        ) : data?.probe.error ? (
          <span className="mini-proxy-probe">{data.probe.error}</span>
        ) : null}
      </div>
      {data && data.availability !== "ready" && data.probe.error ? (
        <div className="mini-proxy-probe-error">{data.probe.error}</div>
      ) : null}
      <Table
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
  const hosts = archipel.hosts.filter((host) => proxyEnabled(host));
  const ready = hosts.filter(
    (host) => proxyData(host)?.availability === "ready",
  ).length;
  const controllable = hosts.filter(
    (host) => proxyData(host)?.control_allowed,
  ).length;
  return (
    <>
      <PageTitle
        eyebrow={t`NETWORK OPERATIONS`}
        title={t`代理出口`}
        description={t`各节点出境代理的出口状态、节点测速与受控切换；切换由节点侧先验证再生效。`}
      />
      <div className="metrics-row">
        <Metric
          label={t`启用节点`}
          value={hosts.length}
          detail={t`已启用 mini-proxy 插件的节点`}
          icon={<Globe size={18} />}
        />
        <Metric
          label={t`出口正常`}
          value={ready}
          detail={t`经代理探测 GitHub 可达`}
          icon={<Activity size={18} />}
        />
        <Metric
          label={t`允许控制`}
          value={controllable}
          detail={t`节点侧开启 allow_control 后可切换`}
          icon={<ShieldCheck size={18} />}
        />
      </div>
      <Section
        title={t`节点出口`}
        subtitle={t`测速在节点本地试跑并实测 GitHub；切换自带失败回滚与 CI 忙时保护。`}
      >
        {hosts.length ? (
          <div className="mini-proxy-grid">
            {hosts.map((host) => (
              <HostProxy key={host.name} host={host} now={now} />
            ))}
          </div>
        ) : (
          <Empty description={t`没有节点启用 mini-proxy 插件`} />
        )}
      </Section>
    </>
  );
}
