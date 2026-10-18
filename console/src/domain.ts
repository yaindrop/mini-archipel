import { defaultTranslate, type Translate } from "./messages.ts";
import { remoteText } from "./messages.ts";
import { i18n } from "@lingui/core";
import type { Host, Point, ScanNode } from "./contracts.ts";
const GiB = 2 ** 30;
const STALE_MS = 10_000;
export const NODE_COLORS = ["#078990", "#5470db", "#a366bd", "#c78b30"];
export const METRICS = [
  {
    key: "cpu.usage_pct",
    get label() {
      return /*i18n*/ "CPU \u5360\u7528";
    },
    unit: "%",
    max: 100,
  },
  {
    key: "mem.used_bytes",
    get label() {
      return /*i18n*/ "\u5185\u5B58\u5DF2\u7528";
    },
    unit: "B",
    max: undefined,
  },
  {
    key: "mem.swap_used_bytes",
    label: "Swap",
    unit: "B",
    max: undefined,
  },
  {
    key: "disk.data_available_bytes",
    get label() {
      return /*i18n*/ "\u53EF\u7528\u5B58\u50A8\u5BB9\u91CF";
    },
    unit: "B",
    max: undefined,
  },
  {
    key: "gpu.usage_pct",
    get label() {
      return /*i18n*/ "GPU \u5360\u7528";
    },
    unit: "%",
    max: 100,
  },
  {
    key: "power.package_w",
    get label() {
      return /*i18n*/ "\u82AF\u7247\u529F\u8017";
    },
    unit: "W",
    max: undefined,
  },
  {
    key: "fan.temp_c",
    get label() {
      return /*i18n*/ "\u6700\u9AD8\u6E29\u5EA6";
    },
    unit: "°C",
    max: undefined,
  },
  {
    key: "fan.rpm",
    get label() {
      return /*i18n*/ "\u98CE\u6247\u8F6C\u901F";
    },
    unit: "RPM",
    max: undefined,
  },
  {
    key: "cpu.p_freq_mhz",
    get label() {
      return /*i18n*/ "P \u6838\u9891\u7387";
    },
    unit: "MHz",
    max: undefined,
  },
  {
    key: "cpu.e_freq_mhz",
    get label() {
      return /*i18n*/ "E \u6838\u9891\u7387";
    },
    unit: "MHz",
    max: undefined,
  },
  {
    key: "power.cpu_w",
    get label() {
      return /*i18n*/ "CPU \u529F\u8017";
    },
    unit: "W",
    max: undefined,
  },
  {
    key: "host.load_1m",
    get label() {
      return /*i18n*/ "1 \u5206\u949F\u8D1F\u8F7D";
    },
    unit: "",
    max: undefined,
  },
] as const;
export const METRIC_KEYS = METRICS.map((m) => m.key);
export function displayName(host: Host): string {
  return host.snapshot?.host?.name.replace(/\.(local|lan)$/, "") ?? host.name;
}
export function isVirtual(host: Host): boolean {
  return host.kind === "virtual";
}
export function nodeKindLabel(
  host: Host,
  translate: Translate = defaultTranslate,
): string {
  return isVirtual(host)
    ? translate(
        /*i18n*/
        {
          id: "\u865A\u62DF\u673A",
          message: "\u865A\u62DF\u673A",
        },
      )
    : translate(
        /*i18n*/
        {
          id: "\u7269\u7406\u673A",
          message: "\u7269\u7406\u673A",
        },
      );
}
export function nodeIdentityLabel(
  host: Host,
  translate: Translate = defaultTranslate,
): string {
  return host.identity.trim() || nodeKindLabel(host, translate);
}
export function stale(host: Host, now: number): boolean {
  return !host.online || now - host.lastTs > STALE_MS;
}
export function sampleFresh(
  sample:
    { ts?: number | undefined; error?: boolean | undefined } | null | undefined,
  now: number,
  maxAge = 10_000,
): boolean {
  return Boolean(
    sample?.ts &&
    !sample.error &&
    sample.ts <= now + 5000 &&
    now - sample.ts <= maxAge,
  );
}
export function dataDisk(host: Host) {
  return (
    host.snapshot?.sys?.disks.find((d) => d.mount === "/System/Volumes/Data") ??
    host.snapshot?.sys?.disks.find((d) => d.mount === "/")
  );
}
export function memoryPct(host: Host): number | null {
  const mem = host.snapshot?.sys?.mem;
  return mem && mem.total_bytes > 0
    ? (mem.used_bytes / mem.total_bytes) * 100
    : null;
}
export function alertsFor(
  hosts: Host[],
  now: number,
  translate: Translate = defaultTranslate,
) {
  return hosts.flatMap((host) => {
    const items: {
      host: Host;
      title: string;
      detail: string;
      tone: "danger" | "warning";
    }[] = [];
    if (stale(host, now))
      return [
        {
          host,
          title: host.online
            ? translate(
                /*i18n*/
                {
                  id: "\u91C7\u96C6\u6570\u636E\u5DF2\u8FC7\u671F",
                  message: "\u91C7\u96C6\u6570\u636E\u5DF2\u8FC7\u671F",
                },
              )
            : translate(
                /*i18n*/
                {
                  id: "\u8282\u70B9\u8FDE\u63A5\u4E2D\u65AD",
                  message: "\u8282\u70B9\u8FDE\u63A5\u4E2D\u65AD",
                },
              ),
          detail:
            (host.lastError
              ? remoteText(host.lastError, translate)
              : undefined) ??
            translate(
              /*i18n*/
              {
                id: "\u7B49\u5F85\u8282\u70B9\u91CD\u65B0\u4E0A\u62A5",
                message: "\u7B49\u5F85\u8282\u70B9\u91CD\u65B0\u4E0A\u62A5",
              },
            ),
          tone: "danger" as const,
        },
      ];
    const current = sampleFresh(host.snapshot?.sys, now);
    if (!current)
      items.push({
        host,
        title: translate(
          /*i18n*/ { id: "系统指标已过期", message: "系统指标已过期" },
        ),
        detail: translate(
          /*i18n*/ {
            id: "节点仍在线，等待采集器恢复；旧读数不参与集群汇总",
            message: "节点仍在线，等待采集器恢复；旧读数不参与集群汇总",
          },
        ),
        tone: "warning",
      });
    const disk = current ? dataDisk(host) : undefined,
      mem = current ? host.snapshot?.sys?.mem : undefined;
    if (disk && disk.available_bytes < 40 * GiB)
      items.push({
        host,
        title: translate(
          /*i18n*/
          {
            id: "\u78C1\u76D8\u4F59\u91CF\u4F4E\u4E8E\u6C34\u4F4D\u7EBF",
            message: "\u78C1\u76D8\u4F59\u91CF\u4F4E\u4E8E\u6C34\u4F4D\u7EBF",
          },
        ),
        detail: translate(
          /*i18n*/
          {
            id: "\u53EF\u7528 {v0}\uFF0C\u6C34\u4F4D\u7EBF 40 GiB",
            message: "\u53EF\u7528 {v0}\uFF0C\u6C34\u4F4D\u7EBF 40 GiB",
            values: {
              v0: formatBytes(disk.available_bytes),
            },
          },
        ),
        tone: "warning",
      });
    if (
      sampleFresh(host.snapshot?.thermal, now, 30_000) &&
      (host.snapshot?.thermal?.state ?? 0) >= 2
    )
      items.push({
        host,
        title: translate(
          /*i18n*/
          {
            id: "\u6563\u70ED\u72B6\u6001\u5F02\u5E38",
            message: "\u6563\u70ED\u72B6\u6001\u5F02\u5E38",
          },
        ),
        detail:
          host.snapshot?.thermal?.state === 3
            ? translate(
                /*i18n*/
                {
                  id: "\u7CFB\u7EDF\u62A5\u544A critical",
                  message: "\u7CFB\u7EDF\u62A5\u544A critical",
                },
              )
            : translate(
                /*i18n*/
                {
                  id: "\u7CFB\u7EDF\u62A5\u544A serious",
                  message: "\u7CFB\u7EDF\u62A5\u544A serious",
                },
              ),
        tone: "danger",
      });
    if (current && (host.snapshot?.sys?.cpu.usage_pct ?? 0) >= 85)
      items.push({
        host,
        title: translate(
          /*i18n*/
          {
            id: "CPU \u5360\u7528\u504F\u9AD8",
            message: "CPU \u5360\u7528\u504F\u9AD8",
          },
        ),
        detail: translate(
          /*i18n*/
          {
            id: "\u5F53\u524D {v0}%",
            message: "\u5F53\u524D {v0}%",
            values: {
              v0: formatNumber(host.snapshot?.sys?.cpu.usage_pct),
            },
          },
        ),
        tone: "warning",
      });
    if (mem && mem.available_bytes < GiB)
      items.push({
        host,
        title: translate(
          /*i18n*/
          {
            id: "\u53EF\u7528\u5185\u5B58\u4E0D\u8DB3 1 GiB",
            message: "\u53EF\u7528\u5185\u5B58\u4E0D\u8DB3 1 GiB",
          },
        ),
        detail: `Swap ${formatBytes(mem.swap_used_bytes)}`,
        tone: "warning",
      });
    return items;
  });
}
export function formatNumber(
  value: number | null | undefined,
  digits = 1,
): string {
  return value == null || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}
export function formatBytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  for (const [size, unit] of [
    [2 ** 40, "TiB"],
    [GiB, "GiB"],
    [2 ** 20, "MiB"],
    [1024, "KiB"],
  ] as const)
    if (Math.abs(value) >= size)
      return `${(value / size).toFixed(value >= 100 * size ? 0 : 1)} ${unit}`;
  return `${String(Math.round(value))} B`;
}
export function uptime(
  seconds: number | undefined,
  translate: Translate = defaultTranslate,
): string {
  if (seconds === undefined) return "—";
  const days = Math.floor(seconds / 86400),
    hours = Math.floor((seconds % 86400) / 3600);
  return days
    ? translate(
        /*i18n*/
        {
          id: "{v0} \u5929 {v1} \u5C0F\u65F6",
          message: "{v0} \u5929 {v1} \u5C0F\u65F6",
          values: {
            v0: String(days),
            v1: String(hours),
          },
        },
      )
    : hours
      ? translate(
          /*i18n*/
          {
            id: "{v0} \u5C0F\u65F6 {v1} \u5206\u949F",
            message: "{v0} \u5C0F\u65F6 {v1} \u5206\u949F",
            values: {
              v0: String(hours),
              v1: String(Math.floor((seconds % 3600) / 60)),
            },
          },
        )
      : translate(
          /*i18n*/
          {
            id: "{v0} \u5206\u949F",
            message: "{v0} \u5206\u949F",
            values: {
              v0: String(Math.floor(seconds / 60)),
            },
          },
        );
}
export function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString(i18n.locale || "zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}
export function metricValue(value: number, unit: string): string {
  return unit === "B"
    ? formatBytes(value)
    : `${formatNumber(value, value >= 100 ? 0 : 1)}${unit === "%" || unit === "°C" ? "" : " "}${unit}`;
}
export function orderedPoints(points: Point[]): Point[] {
  return [
    ...new Map(
      points
        .filter((p) => Number.isFinite(p.ts) && Number.isFinite(p.value))
        .map((p) => [p.ts, p]),
    ).values(),
  ].sort((a, b) => a.ts - b.ts);
}
/** Account only for leaves plus a parent's unallocated remainder; never count the same bytes twice. */
export function storageClasses(scan: ScanNode): Map<string, number> {
  const totals = new Map<string, number>();
  const visit = (node: ScanNode, budget: number) => {
    const totalChildren = node.children.reduce((sum, c) => sum + c.bytes, 0);
    const scale = totalChildren > budget ? budget / totalChildren : 1;
    for (const child of node.children) visit(child, child.bytes * scale);
    const rest = Math.max(0, budget - totalChildren);
    totals.set(node.class, (totals.get(node.class) ?? 0) + rest);
  };
  visit(scan, scan.bytes);
  return new Map(
    [...totals].filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]),
  );
}
