import { useLingui } from "@lingui/react";
import { useLingui as useLinguiMacro } from "@lingui/react/macro";
import { useRef, useEffect } from "react";
import { Link, useSearchParams } from "react-router";
import {
  Badge,
  Descriptions,
  Empty,
  Grid,
  Input,
  Progress,
  Segmented,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  type InputRef,
  type TableColumnsType,
} from "antd";
import {
  Activity,
  ArrowUpRight,
  CheckCircle2,
  Cpu,
  HardDrive,
  Search,
  Server,
  ShieldCheck,
  MemoryStick,
  TriangleAlert,
} from "lucide-react";
import type { Fleet, Host } from "../contracts.ts";
import {
  alertsFor,
  dataDisk,
  displayName,
  formatBytes,
  formatNumber,
  isVirtual,
  memoryPct,
  NODE_COLORS,
  stale,
  uptime,
} from "../domain.ts";
import { HostIdentity, Metric, NodeStatus, PageTitle, Section } from "./ui.tsx";
import { PluginSlot, useWorkbenchPlugins } from "./plugins.tsx";
import { Spark, TimeChart } from "./chart.tsx";
export function Overview({ fleet, now }: { fleet: Fleet; now: number }) {
  const { _ } = useLingui();
  const { t } = useLinguiMacro();
  const [search, setSearch] = useSearchParams(),
    ref = useRef<InputRef>(null),
    screens = Grid.useBreakpoint();
  const query = search.get("q") ?? "",
    filter = search.get("type") ?? "all",
    sort = search.get("sort") ?? "name",
    order =
      search.get("order") === "ascend"
        ? "ascend"
        : search.get("order") === "descend"
          ? "descend"
          : ["cpu", "memory"].includes(sort)
            ? "descend"
            : "ascend",
    metric = search.get("metric") === "memory" ? "memory" : "cpu";
  const update = (key: string, value: string) => {
    const next = new URLSearchParams(search);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearch(next, {
      replace: true,
    });
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.key === "/" &&
        !(event.target instanceof HTMLInputElement) &&
        !(event.target instanceof HTMLTextAreaElement) &&
        !(event.target instanceof HTMLElement && event.target.isContentEditable)
      ) {
        event.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
    };
  }, []);
  const plugins = useWorkbenchPlugins(fleet);
  const fresh = fleet.hosts.filter((h) => !stale(h, now));
  const memoryTotal = fresh.reduce(
      (sum, h) => sum + (h.snapshot?.sys?.mem.total_bytes ?? 0),
      0,
    ),
    memoryUsed = fresh.reduce(
      (sum, h) => sum + (h.snapshot?.sys?.mem.used_bytes ?? 0),
      0,
    );
  const cores = fresh.reduce((n, h) => n + (h.snapshot?.host?.cores ?? 0), 0),
    cpu = cores
      ? fresh.reduce(
          (n, h) =>
            n +
            (h.snapshot?.sys?.cpu.usage_pct ?? 0) *
              (h.snapshot?.host?.cores ?? 0),
          0,
        ) / cores
      : null,
    disks = fresh.flatMap((h) => {
      const disk = dataDisk(h);
      return disk ? [disk] : [];
    }),
    disk = disks.reduce((n, d) => n + d.available_bytes, 0),
    alerts = alertsFor(fleet.hosts, now, _);
  const filtered = fleet.hosts.filter(
    (h) =>
      displayName(h).toLowerCase().includes(query.toLowerCase()) &&
      (filter === "all" ||
        (filter === "physical" && Boolean(h.snapshot?.host) && !isVirtual(h)) ||
        (filter === "virtual" && isVirtual(h)) ||
        (filter === "attention" && alerts.some((a) => a.host.name === h.name))),
  );
  const sorted = filtered.toSorted((a, b) => {
    const delta =
      sort === "cpu"
        ? (a.snapshot?.sys?.cpu.usage_pct ?? -1) -
          (b.snapshot?.sys?.cpu.usage_pct ?? -1)
        : sort === "memory"
          ? (memoryPct(a) ?? -1) - (memoryPct(b) ?? -1)
          : sort === "disk"
            ? (dataDisk(a)?.available_bytes ?? -1) -
              (dataDisk(b)?.available_bytes ?? -1)
            : displayName(a).localeCompare(displayName(b));
    return order === "descend" ? -delta : delta;
  });
  const columns: TableColumnsType<Host> = [
    {
      title: t`节点 / 规格`,
      key: "name",
      rowScope: "row",
      sorter: true,
      sortOrder: sort === "name" ? order : null,
      sortDirections: ["ascend", "descend"],
      render: (_value: unknown, h) => (
        <div className="node-identity-cell">
          <Link
            to={`/nodes/${encodeURIComponent(h.name)}`}
            aria-label={t`查看节点 ${displayName(h)}`}
          >
            <HostIdentity host={h} index={fleet.hosts.indexOf(h)} />
          </Link>
          {!screens.md ? (
            <div className="node-compact-details">
              <Space>
                <NodeStatus host={h} now={now} />
                <Typography.Text type="secondary">
                  {uptime(h.snapshot?.host?.uptime_s, _)}
                </Typography.Text>
              </Space>
              <Descriptions
                size="small"
                column={3}
                layout="vertical"
                items={[
                  {
                    key: "cpu",
                    label: "CPU",
                    children: (
                      <span className="num">
                        {formatNumber(h.snapshot?.sys?.cpu.usage_pct)}%
                      </span>
                    ),
                  },
                  {
                    key: "memory",
                    label: t`内存`,
                    children: (
                      <span className="num">
                        {formatNumber(memoryPct(h), 0)}%
                      </span>
                    ),
                  },
                  {
                    key: "disk",
                    label: t`可用存储容量`,
                    children: (
                      <span className="num">
                        {formatBytes(dataDisk(h)?.available_bytes)}
                      </span>
                    ),
                  },
                ]}
              />
            </div>
          ) : null}
        </div>
      ),
    },
    {
      title: t`状态`,
      key: "state",
      responsive: ["md"],
      render: (_v: unknown, h) => (
        <>
          <NodeStatus host={h} now={now} />
          <small className="cell-sub">
            {uptime(h.snapshot?.host?.uptime_s, _)}
          </small>
        </>
      ),
    },
    {
      title: "CPU",
      key: "cpu",
      sorter: true,
      sortOrder: sort === "cpu" ? order : null,
      sortDirections: ["descend", "ascend"],
      responsive: ["md"],
      render: (_v: unknown, h) => (
        <div className="cpu-cell">
          <span className="num">
            {formatNumber(h.snapshot?.sys?.cpu.usage_pct)}
            <small>%</small>
          </span>
          <Spark
            points={h.history["cpu.usage_pct"] ?? []}
            color={NODE_COLORS[fleet.hosts.indexOf(h) % 4] ?? "#08727e"}
          />
        </div>
      ),
    },
    {
      title: t`内存`,
      key: "memory",
      sorter: true,
      sortOrder: sort === "memory" ? order : null,
      sortDirections: ["descend", "ascend"],
      responsive: ["md"],
      render: (_v: unknown, h) => (
        <div className="resource-cell">
          <span className="num">{formatNumber(memoryPct(h), 0)}%</span>
          <Progress
            percent={memoryPct(h) ?? 0}
            showInfo={false}
            size="small"
            aria-label={t`${displayName(h)} 内存占用`}
          />
          <small className="cell-sub">
            {formatBytes(h.snapshot?.sys?.mem.used_bytes)}
          </small>
        </div>
      ),
    },
    {
      title: t`可用存储容量`,
      key: "disk",
      sorter: true,
      sortOrder: sort === "disk" ? order : null,
      sortDirections: ["ascend", "descend"],
      responsive: ["md"],
      render: (_v: unknown, h) => {
        const d = dataDisk(h);
        return (
          <div className="resource-cell">
            <span className="num">{formatBytes(d?.available_bytes)}</span>
            <Progress
              percent={
                d
                  ? (1 - d.available_bytes / Math.max(1, d.total_bytes)) * 100
                  : 0
              }
              showInfo={false}
              size="small"
              strokeColor={
                d && d.available_bytes < 40 * 2 ** 30 ? "#b17a24" : "#8095b3"
              }
              aria-label={t`${displayName(h)} 磁盘已用比例`}
            />
          </div>
        );
      },
    },
    ...plugins.flatMap(
      (plugin) =>
        plugin.columns?.({
          fleet,
          now,
        }) ?? [],
    ),
    {
      title: <span className="sr-only">{t`查看`}</span>,
      key: "detail",
      width: 48,
      render: (_v: unknown, h) => (
        <Link
          className="node-detail-link"
          aria-label={t`查看 ${displayName(h)}`}
          to={`/nodes/${encodeURIComponent(h.name)}`}
        >
          <ArrowUpRight size={17} />
        </Link>
      ),
    },
  ];
  const virtual = fleet.hosts.filter(isVirtual).length,
    physical = fleet.hosts.length - virtual;
  return (
    <>
      <PageTitle
        title={t`集群概览`}
        description={t`从全局状态到每台节点，掌握资源与运行情况。`}
        action={
          <Tag
            color={alerts.length ? "warning" : "success"}
            icon={
              alerts.length ? (
                <TriangleAlert size={13} />
              ) : (
                <CheckCircle2 size={13} />
              )
            }
          >
            {alerts.length
              ? t`${String(alerts.length)} 项需要关注`
              : t`集群运行正常`}
          </Tag>
        }
      />
      <div className="metrics-row">
        <Metric
          label={t`在线节点`}
          value={
            <>
              {fresh.length}
              <span>/ {fleet.hosts.length}</span>
            </>
          }
          detail={t`${String(physical)} 台物理机 · ${String(virtual)} 台虚拟机`}
          icon={<Server size={18} />}
        />
        <Metric
          label={t`集群核心负载`}
          value={
            <>
              {formatNumber(cpu)}
              <span>%</span>
            </>
          }
          detail={t`${String(cores)} 核 · 按在线节点核心数加权`}
          icon={<Cpu size={18} />}
        />
        <Metric
          label={t`集群内存负载`}
          value={
            memoryTotal
              ? `${formatNumber((memoryUsed / memoryTotal) * 100, 0)}%`
              : "—"
          }
          detail={t`已用 ${formatBytes(memoryUsed)} / ${formatBytes(memoryTotal)}`}
          icon={<MemoryStick size={18} />}
        />
        <Metric
          label={t`集群可用存储容量`}
          value={disks.length ? formatBytes(disk) : "—"}
          detail={t`各在线节点报告的卷可用空间之和`}
          icon={<HardDrive size={18} />}
        />
      </div>
      <Section
        title={t`全部节点`}
        className="nodes-panel"
        action={
          <Typography.Text type="secondary" className="num">
            {t`${fleet.hosts.length} 个节点`}
          </Typography.Text>
        }
      >
        <div className="table-toolbar">
          <Input
            ref={ref}
            prefix={<Search size={16} />}
            suffix={<kbd>/</kbd>}
            aria-label={t`搜索节点`}
            value={query}
            onChange={(e) => {
              update("q", e.target.value);
            }}
            placeholder={t`搜索节点名称`}
            allowClear
            className="node-search"
          />
          <Select
            aria-label={t`筛选节点类型`}
            value={filter}
            onChange={(value) => {
              update("type", value);
            }}
            virtual={false}
            options={[
              {
                value: "all",
                label: t`全部类型`,
              },
              {
                value: "physical",
                label: t`物理机`,
              },
              {
                value: "virtual",
                label: t`虚拟机`,
              },
              {
                value: "attention",
                label: t`需要关注`,
              },
            ]}
          />
          {!screens.md ? (
            <Select
              aria-label={t`节点排序`}
              value={sort}
              virtual={false}
              options={[
                {
                  value: "name",
                  label: t`名称排序`,
                },
                {
                  value: "cpu",
                  label: t`CPU 从高到低`,
                },
                {
                  value: "memory",
                  label: t`内存从高到低`,
                },
                {
                  value: "disk",
                  label: t`可用容量从低到高`,
                },
              ]}
              onChange={(value) => {
                const next = new URLSearchParams(search);
                next.set("sort", value);
                next.set(
                  "order",
                  ["cpu", "memory"].includes(value) ? "descend" : "ascend",
                );
                setSearch(next, {
                  replace: true,
                });
              }}
            />
          ) : null}
        </div>
        <Table<Host>
          className="nodes-table"
          rowKey="name"
          columns={columns}
          dataSource={sorted}
          pagination={false}
          size="middle"
          rowClassName={(h) => (stale(h, now) ? "row-stale" : "")}
          footer={(rows) => (
            <div className="panel-footnote">
              <Activity size={13} />
              <span>{t`每秒采集 · 数据超过 10 秒未更新时标记过期`}</span>
              <span>{t`共 ${rows.length} / ${fleet.hosts.length} 台`}</span>
            </div>
          )}
          locale={{
            emptyText: (
              <Empty
                description={t`没有匹配的节点，调整名称或类型筛选后重试。`}
              />
            ),
          }}
          onChange={(_pagination, _filters, sorter) => {
            const column = Array.isArray(sorter) ? sorter[0] : sorter;
            const next = new URLSearchParams(search);
            next.set("sort", column?.order ? String(column.columnKey) : "name");
            next.set("order", column?.order ?? "ascend");
            setSearch(next, {
              replace: true,
            });
          }}
        />
      </Section>
      <div className="overview-columns">
        <Section
          title={t`资源走势`}
          subtitle={t`节点间的同尺度比较 · 最近 10 分钟`}
          action={
            <Segmented
              aria-label={t`资源指标`}
              value={metric}
              onChange={(value) => {
                update("metric", value);
              }}
              options={[
                {
                  label: "CPU",
                  value: "cpu",
                },
                {
                  label: t`内存`,
                  value: "memory",
                },
              ]}
            />
          }
        >
          <TimeChart
            label={metric === "cpu" ? t`CPU 占用走势` : t`内存占用走势`}
            unit="%"
            max={100}
            series={fleet.hosts.map((h, i) => ({
              name: displayName(h),
              color: NODE_COLORS[i % 4] ?? "#08727e",
              points:
                metric === "cpu"
                  ? (h.history["cpu.usage_pct"] ?? [])
                  : (h.history["mem.used_bytes"] ?? []).map((p) => ({
                      ...p,
                      value:
                        (p.value / (h.snapshot?.sys?.mem.total_bytes ?? 1)) *
                        100,
                    })),
            }))}
          />
        </Section>
        <Section
          title={t`需要关注`}
          action={
            <Badge
              count={alerts.length}
              showZero
              color={alerts.length ? "#95620f" : "#5c6c80"}
            />
          }
        >
          {alerts.length ? (
            <div className="attention-list">
              {alerts.map((a) => (
                <Link
                  key={`${a.host.name}-${a.title}`}
                  className={`attention-item attention-${a.tone}`}
                  to={`/nodes/${encodeURIComponent(a.host.name)}`}
                >
                  <TriangleAlert size={17} />
                  <span>
                    <strong>{a.title}</strong>
                    <small>
                      {displayName(a.host)} · {a.detail}
                    </small>
                  </span>
                  <ArrowUpRight size={14} />
                </Link>
              ))}
            </div>
          ) : (
            <div className="all-clear">
              <span className="healthy-symbol">
                <ShieldCheck size={30} />
              </span>
              <strong>{t`当前运行平稳`}</strong>
              <Typography.Paragraph type="secondary">{t`未检测到节点失联、低磁盘余量或散热告警。`}</Typography.Paragraph>
              <Typography.Text type="success">
                <CheckCircle2 size={14} />
                {t` 持续检查节点状态 `}
              </Typography.Text>
            </div>
          )}
        </Section>
      </div>
      {plugins.map((plugin) =>
        plugin.OverviewPanel ? (
          <PluginSlot key={plugin.id} label={plugin.label}>
            <plugin.OverviewPanel fleet={fleet} now={now} />
          </PluginSlot>
        ) : null,
      )}
      <Section title={t`运行概况`}>
        <Descriptions
          column={{
            xs: 2,
            sm: 2,
            md: 4,
          }}
          layout="vertical"
          items={[
            {
              key: "arch",
              label: t`节点架构`,
              children:
                [
                  ...new Set(
                    fleet.hosts
                      .map((h) => h.snapshot?.host?.arch)
                      .filter(Boolean),
                  ),
                ].join(" / ") || t`等待采集`,
            },
            {
              key: "extensions",
              label: t`已启用插件`,
              children: <Link to="/plugins">{t`${plugins.length} 个 ↗`}</Link>,
            },
            {
              key: "sensors",
              label: t`物理传感器`,
              children: t`${String(fleet.hosts.filter((h) => h.snapshot?.fan).length)} 台已上报`,
            },
          ]}
        />
        <div className="context-note">{t`虚拟机由宿主机负责散热，节点详情按实际能力展示传感器。`}</div>
      </Section>
    </>
  );
}
