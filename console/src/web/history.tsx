import { useLingui } from "@lingui/react";
import { msg } from "@lingui/core/macro";
import { useLingui as useLinguiMacro } from "@lingui/react/macro";
import { useQueries } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { Download, RefreshCw } from "lucide-react";
import {
  Alert,
  Button,
  Select,
  Segmented,
  Typography,
  Descriptions,
} from "antd";
import type { Fleet } from "../contracts.ts";
import { displayName, metricValue, METRICS, NODE_COLORS } from "../domain.ts";
import { api, message } from "./api.ts";
import { PageTitle, Section } from "./ui.tsx";
import { TimeChart } from "./chart.tsx";
const WINDOWS = [
  {
    get label() {
      return msg`10 分钟`;
    },
    ms: 600_000,
  },
  {
    get label() {
      return msg`1 小时`;
    },
    ms: 3600_000,
  },
  {
    get label() {
      return msg`24 小时`;
    },
    ms: 86400_000,
  },
  {
    get label() {
      return msg`7 天`;
    },
    ms: 7 * 86400_000,
  },
  {
    get label() {
      return msg`30 天`;
    },
    ms: 30 * 86400_000,
  },
];
export function csvCell(value: string): string {
  return `"${value.replace(/^[=+@-]/, "'$&").replaceAll('"', '""')}"`;
}
export function History({
  fleet,
  paused,
  now,
}: {
  fleet: Fleet;
  paused: boolean;
  now: number;
}) {
  const { t } = useLinguiMacro();
  const { _ } = useLingui();
  const metrics = METRICS.map((metric) => ({
    ...metric,
    label: _(metric.label),
  }));
  const [search, setSearch] = useSearchParams(),
    metric = metrics.find((m) => m.key === search.get("metric")) ?? {
      ...METRICS[0],
      label: _(METRICS[0].label),
    },
    window =
      WINDOWS.find((w) => w.ms === Number(search.get("window"))) ??
      WINDOWS[1] ??
      WINDOWS[0];
  const selected = search.get("host") ?? "all",
    hosts =
      selected === "all"
        ? fleet.hosts
        : fleet.hosts.filter((h) => h.name === selected),
    windowMs = window?.ms ?? 3600_000;
  const update = (key: string, value: string) => {
    const next = new URLSearchParams(search);
    next.set(key, value);
    setSearch(next, {
      replace: true,
    });
  };
  const queries = useQueries({
    queries: hosts.map((host) => ({
      queryKey: ["history", host.name, metric.key, windowMs],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.history(host.name, metric.key, windowMs, signal),
      enabled: !paused,
      refetchInterval: paused ? (false as const) : 15000,
      retry: 1,
    })),
  });
  const series = hosts.map((host, i) => ({
    name: displayName(host),
    color: NODE_COLORS[fleet.hosts.indexOf(host) % 4] ?? "#078990",
    points: queries[i]?.data?.points ?? [],
  }));
  const error = queries.find((q) => q.error)?.error,
    loading = queries.some((q) => q.isFetching),
    latest = Math.max(...queries.map((q) => q.dataUpdatedAt), now - 15_000);
  const download = () => {
    const rows = [
      "node,timestamp,value,unit",
      ...series.flatMap((s) =>
        s.points.map((p) =>
          [
            csvCell(s.name),
            new Date(p.ts).toISOString(),
            String(p.value),
            csvCell(metric.unit),
          ].join(","),
        ),
      ),
    ];
    const url = URL.createObjectURL(
      new Blob(["\uFEFF" + rows.join("\r\n")], {
        type: "text/csv;charset=utf-8",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = t`群岛-${metric.key}-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  return (
    <>
      <PageTitle
        eyebrow={t`HISTORICAL METRICS`}
        title={t`历史趋势`}
        description={t`比较不同节点，沿时间检查资源变化。`}
        action={
          <Button
            icon={<Download size={16} />}
            disabled={!series.some((s) => s.points.length)}
            onClick={download}
          >{t`导出 CSV`}</Button>
        }
      />
      <Section
        title={t`指标分析`}
        subtitle={t`采样数据按时间范围聚合，保留最近一年的历史。`}
        action={
          <span className="history-refresh">
            <RefreshCw size={13} className={loading ? "spin" : ""} />
            {paused ? t`更新已暂停` : t`每 15 秒更新`}
          </span>
        }
      >
        <div className="history-toolbar">
          <label htmlFor="history-host">
            <Typography.Text type="secondary">{t`节点`}</Typography.Text>
            <Select
              id="history-host"
              aria-label={t`历史节点`}
              value={selected}
              virtual={false}
              onChange={(value) => {
                update("host", value);
              }}
              options={[
                {
                  value: "all",
                  label: t`全部节点`,
                },
                ...fleet.hosts.map((h) => ({
                  value: h.name,
                  label: displayName(h),
                })),
              ]}
            />
          </label>
          <label htmlFor="history-metric">
            <Typography.Text type="secondary">{t`指标`}</Typography.Text>
            <Select
              id="history-metric"
              aria-label={t`历史指标`}
              value={metric.key}
              virtual={false}
              onChange={(value) => {
                update("metric", value);
              }}
              options={metrics.map((m) => ({
                value: m.key,
                label: m.label,
              }))}
            />
          </label>
          <Segmented
            className="history-windows"
            aria-label={t`历史时间范围`}
            value={windowMs}
            options={WINDOWS.map((w) => ({
              value: w.ms,
              label: _(w.label),
            }))}
            onChange={(value) => {
              update("window", String(value));
            }}
          />
        </div>
        {error ? (
          <Alert type="error" showIcon title={message(error, _)} role="alert" />
        ) : null}
        <div className="history-main-chart">
          <TimeChart
            label={t`${metric.label}历史趋势`}
            unit={metric.unit}
            max={metric.max}
            range={[latest - windowMs, latest]}
            series={series}
          />
        </div>
        <div className="history-stat-grid">
          {series.map((s) => {
            const values = s.points.map((p) => p.value),
              avg = values.length
                ? values.reduce((sum, v) => sum + v, 0) / values.length
                : undefined;
            return (
              <div key={s.name}>
                <strong>
                  <i
                    style={{
                      background: s.color,
                    }}
                  />
                  {s.name}
                </strong>
                <Descriptions
                  size="small"
                  column={1}
                  items={[
                    {
                      key: "average",
                      label: t`平均`,
                      children:
                        avg === undefined ? "—" : metricValue(avg, metric.unit),
                    },
                    {
                      key: "peak",
                      label: t`峰值`,
                      children: values.length
                        ? metricValue(Math.max(...values), metric.unit)
                        : "—",
                    },
                    {
                      key: "count",
                      label: t`采样点`,
                      children: values.length,
                    },
                  ]}
                />
              </div>
            );
          })}
        </div>
      </Section>
      <div className="page-note">{t`早期数据不足时仅展示已有样本；传感器未上报的指标保持空白。`}</div>
    </>
  );
}
