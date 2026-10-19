import { useLingui } from "@lingui/react";
import { useLingui as useLinguiMacro } from "@lingui/react/macro";
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import {
  Alert,
  Badge,
  Descriptions,
  Empty,
  Input,
  Progress,
  Space,
  Table,
  Tabs,
  Typography,
  type TableColumnsType,
} from "antd";
import {
  Cpu,
  Fan,
  HardDrive,
  Layers,
  MemoryStick,
  Search,
  Thermometer,
  Zap,
} from "lucide-react";
import type { Archipel, Host, Snapshot } from "../contracts.ts";
import {
  dataDisk,
  displayName,
  formatBytes,
  formatNumber,
  isVirtual,
  memoryPct,
  nodeKindLabel,
  nodeIdentityLabel,
  NODE_COLORS,
  stale,
  sampleFresh,
  uptime,
} from "../domain.ts";
import { HostIdentity, Metric, NodeStatus, PageTitle, Section } from "./ui.tsx";
import { TimeChart } from "./chart.tsx";
import { PluginSlot, useWorkbenchPlugins } from "./plugins.tsx";
import { StorageBrowser } from "./storage.tsx";
type Process = NonNullable<Snapshot["sys"]>["procs"][number];
function Processes({ host }: { host: Host }) {
  const { t } = useLinguiMacro();
  const [query, setQuery] = useState("");
  const procs = (host.snapshot?.sys?.procs ?? []).filter(
    (p) =>
      p.name.toLowerCase().includes(query.toLowerCase()) ||
      String(p.pid).includes(query),
  );
  const columns: TableColumnsType<Process> = [
    {
      title: t`进程`,
      key: "name",
      dataIndex: "name",
      rowScope: "row",
      sorter: (a, b) => a.name.localeCompare(b.name),
      render: (name: string) => <span className="process-name">{name}</span>,
    },
    {
      title: "PID",
      key: "pid",
      dataIndex: "pid",
      responsive: ["sm"],
      render: (pid: number) => <span className="num muted">{pid}</span>,
    },
    {
      title: "CPU",
      key: "cpu",
      align: "right",
      sorter: (a, b) => a.cpu_pct - b.cpu_pct,
      defaultSortOrder: "descend",
      render: (_value: unknown, p) => (
        <span className="num">{formatNumber(p.cpu_pct)}%</span>
      ),
    },
    {
      title: t`内存`,
      key: "memory",
      align: "right",
      sorter: (a, b) => a.mem_bytes - b.mem_bytes,
      render: (_v: unknown, p) => (
        <span className="num">{formatBytes(p.mem_bytes)}</span>
      ),
    },
  ];
  return (
    <Section
      title={t`活跃进程`}
      subtitle={t`节点按 CPU 采集的前 15 个进程；单进程可使用多个核心。`}
    >
      <div className="table-toolbar">
        <Input
          prefix={<Search size={16} />}
          aria-label={t`搜索进程`}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
          placeholder={t`进程名称或 PID`}
          allowClear
        />
      </div>
      <Table<Process>
        className="process-table"
        tableLayout="fixed"
        rowKey="pid"
        columns={columns}
        dataSource={procs}
        pagination={false}
        locale={{
          emptyText: <Empty description={t`没有匹配的进程`} />,
        }}
      />
    </Section>
  );
}
export function NodeDetail({
  archipel,
  now,
}: {
  archipel: Archipel;
  now: number;
}) {
  const { _ } = useLingui();
  const { t } = useLinguiMacro();
  const { name } = useParams(),
    host = archipel.hosts.find((h) => h.name === name),
    [search, setSearch] = useSearchParams(),
    view = search.get("view") ?? "overview";
  const plugins = useWorkbenchPlugins(archipel).toSorted(
    (a, b) => (a.nodeOrder ?? 0) - (b.nodeOrder ?? 0),
  );
  if (!host)
    return (
      <>
        <PageTitle
          eyebrow={t`NODE`}
          title={t`节点不存在`}
          description={t`节点可能已从集群配置中移除。`}
        />
        <Link to="/">{t`返回集群概览`}</Link>
      </>
    );
  const index = archipel.hosts.indexOf(host),
    disk = dataDisk(host),
    mem = host.snapshot?.sys?.mem,
    fan = host.snapshot?.fan,
    mac = host.snapshot?.macmon;
  const thermalFresh = sampleFresh(host.snapshot?.thermal, now, 30_000);
  const thermalLabel =
    [t`正常`, t`温暖`, t`严重`, t`危急`][host.snapshot?.thermal?.state ?? -1] ??
    t`未上报`;
  const thermal =
    host.snapshot?.thermal && !thermalFresh
      ? `${thermalLabel} · ${t`数据已过期`}`
      : thermalLabel;
  const overview = (
    <>
      {host.snapshot?.sys && !sampleFresh(host.snapshot.sys, now) && (
        <Alert
          showIcon
          type="warning"
          title={t`系统指标已过期，显示最后有效读数`}
        />
      )}
      <div className="metrics-row">
        <Metric
          label={t`CPU 占用`}
          value={
            <>
              {formatNumber(host.snapshot?.sys?.cpu.usage_pct)}
              <span>%</span>
            </>
          }
          detail={
            host.snapshot?.host
              ? t`${String(host.snapshot.host.cores)} 个核心 · 负载 ${formatNumber(host.snapshot.host.load[0], 2)}`
              : t`等待 CPU 信息`
          }
          icon={<Cpu size={18} />}
        />
        <Metric
          label={t`内存已用`}
          value={
            <>
              {formatNumber(memoryPct(host), 0)}
              <span>%</span>
            </>
          }
          detail={`${formatBytes(mem?.used_bytes)} / ${formatBytes(mem?.total_bytes)}`}
          icon={<MemoryStick size={18} />}
        />
        <Metric
          label={t`可用存储容量`}
          value={formatBytes(disk?.available_bytes)}
          detail={t`总容量 ${formatBytes(disk?.total_bytes)}`}
          icon={<HardDrive size={18} />}
        />
        <Metric
          label={t`Swap 已用`}
          value={formatBytes(mem?.swap_used_bytes)}
          detail={t`可用内存 ${formatBytes(mem?.available_bytes)}`}
          icon={<Layers size={18} />}
        />
      </div>
      <div className="node-overview-columns">
        {(
          [
            ["cpu.usage_pct", t`CPU 走势`, "%", 100],
            ["mem.used_bytes", t`内存走势`, "B", mem?.total_bytes],
          ] as const
        ).map(([key, title, unit, max]) => (
          <Section key={key} title={title} subtitle={t`最近 10 分钟`}>
            <TimeChart
              label={`${displayName(host)} ${title}`}
              unit={unit}
              max={max}
              series={[
                {
                  name: displayName(host),
                  color: NODE_COLORS[index % 4] ?? "#08727e",
                  points: host.history[key] ?? [],
                },
              ]}
            />
          </Section>
        ))}
        <Section title={t`传感器`}>
          {!isVirtual(host) &&
            [fan, mac].some(
              (sample) => sample && !sampleFresh(sample, now),
            ) && (
              <Alert
                type="warning"
                showIcon
                title={t`部分传感器已过期，显示最后有效读数`}
              />
            )}
          {!isVirtual(host) ? (
            <div className="sensor-list">
              <div>
                <Space>
                  <Thermometer size={16} />
                  <span>{t`最高温度`}</span>
                </Space>
                <strong>
                  {!fan || fan.have_temp === false
                    ? "—"
                    : `${formatNumber(fan.temp)} °C`}
                </strong>
              </div>
              <div>
                <Space>
                  <Fan size={16} />
                  <span>{t`风扇转速`}</span>
                </Space>
                <strong>{formatNumber(fan?.rpm, 0)} RPM</strong>
              </div>
              <div>
                <span>{t`控制模式`}</span>
                <strong>
                  {!fan
                    ? t`未上报`
                    : fan.paused
                      ? t`已暂停`
                      : fan.forced
                        ? t`自定义曲线`
                        : t`系统自动`}
                </strong>
              </div>
              <div>
                <Space>
                  <Zap size={16} />
                  <span>{t`芯片功耗`}</span>
                </Space>
                <strong>{formatNumber(mac?.package_power_w)} W</strong>
              </div>
              <div>
                <Space>
                  <Cpu size={16} />
                  <span>{t`P / E 核频率`}</span>
                </Space>
                <strong>
                  {formatNumber(mac?.p_cluster_mhz, 0)} /{" "}
                  {formatNumber(mac?.e_cluster_mhz, 0)} MHz
                </strong>
              </div>
              <div>
                <span>{t`GPU 占用`}</span>
                <strong>{formatNumber(mac?.gpu_pct)}%</strong>
              </div>
            </div>
          ) : (
            <Empty
              image={<Layers size={38} />}
              description={t`虚拟机无硬件传感器`}
            />
          )}
        </Section>
      </div>
      <Section
        title={t`各核心占用`}
        subtitle={t`展示节点上报的核心顺序，不推测核心类型。`}
      >
        <div className="core-grid">
          {(host.snapshot?.sys?.cpu.cores ?? []).map((value, i) => (
            <div key={i} className="core-cell">
              <Typography.Text type="secondary">
                {t`核心 ${String(i + 1).padStart(2, "0")}`}
              </Typography.Text>
              <strong className="num">
                {formatNumber(value, 0)}
                <small>%</small>
              </strong>
              <Progress
                percent={value}
                showInfo={false}
                size="small"
                {...(value > 85
                  ? {
                      strokeColor: "#b17a24",
                    }
                  : {})}
                aria-label={t`核心 ${String(i + 1)} 占用`}
              />
            </div>
          ))}
        </div>
      </Section>
      <Section title={t`节点信息`}>
        <div className="node-info">
          <HostIdentity host={host} index={index} />
          <Descriptions
            column={{
              xs: 1,
              sm: 3,
            }}
            size="small"
            items={[
              {
                key: "kind",
                label: t`类型`,
                children: nodeKindLabel(host, _),
              },
              {
                key: "identity",
                label: t`身份`,
                children: nodeIdentityLabel(host, _),
              },
              {
                key: "os",
                label: t`系统`,
                children: host.snapshot?.host?.os ?? t`未上报`,
              },
              {
                key: "agent",
                label: "Agent",
                children: `v${host.snapshot?.agent.version ?? "—"}`,
              },
              {
                key: "uptime",
                label: t`运行时间`,
                children: uptime(host.snapshot?.host?.uptime_s, _),
              },
              {
                key: "thermal",
                label: t`热状态`,
                children: (
                  <Badge
                    status={
                      !thermalFresh || (host.snapshot?.thermal?.state ?? 0) >= 2
                        ? "warning"
                        : "default"
                    }
                    text={thermal}
                  />
                ),
              },
            ]}
          />
          <Link
            to={`/history?host=${encodeURIComponent(host.name)}`}
          >{t`查看历史趋势`}</Link>
        </div>
      </Section>
      {plugins.map((plugin) =>
        plugin.NodePanel ? (
          <PluginSlot key={plugin.id} label={plugin.label}>
            <plugin.NodePanel archipel={archipel} host={host} now={now} />
          </PluginSlot>
        ) : null,
      )}
    </>
  );
  return (
    <>
      <PageTitle
        className="node-heading"
        eyebrow={nodeKindLabel(host, _)}
        title={displayName(host)}
        description={nodeIdentityLabel(host, _)}
        action={<NodeStatus host={host} now={now} />}
      />
      {stale(host, now) ? (
        <Alert
          type="warning"
          showIcon
          title={
            host.lastError ??
            t`节点超过 10 秒未更新。下方保留最后一次采集结果，运维操作暂不可用。`
          }
        />
      ) : null}
      <Tabs
        className="node-tabs"
        animated={false}
        activeKey={
          [
            "overview",
            "processes",
            "storage",
            ...plugins
              .filter((plugin) => plugin.NodePanel)
              .map((plugin) => plugin.id),
          ].includes(view)
            ? view
            : "overview"
        }
        onChange={(key) => {
          setSearch(
            {
              view: key,
            },
            {
              replace: true,
            },
          );
        }}
        tabBarExtraContent={
          <Typography.Text
            type="secondary"
            className="node-uptime"
          >{t`运行 ${uptime(host.snapshot?.host?.uptime_s, _)}`}</Typography.Text>
        }
        items={[
          {
            key: "overview",
            label: t`节点概览`,
            children: overview,
          },
          {
            key: "processes",
            label: t`活跃进程`,
            children: <Processes host={host} />,
          },
          {
            key: "storage",
            label: t`存储分析`,
            children: <StorageBrowser key={host.name} host={host} now={now} />,
          },
          ...plugins.flatMap((plugin) =>
            plugin.NodePanel
              ? [
                  {
                    key: plugin.id,
                    label: plugin.label,
                    children: (
                      <PluginSlot label={plugin.label}>
                        <plugin.NodePanel
                          archipel={archipel}
                          host={host}
                          now={now}
                        />
                      </PluginSlot>
                    ),
                  },
                ]
              : [],
          ),
        ]}
      />
    </>
  );
}
