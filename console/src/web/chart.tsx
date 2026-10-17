import { useLingui as useLinguiMacro } from "@lingui/react/macro";
import { useLayoutEffect, useId, useRef, useState } from "react";
import type { Point } from "../contracts.ts";
import { metricValue, timeLabel, orderedPoints } from "../domain.ts";
export interface ChartSeries {
  name: string;
  color: string;
  points: Point[];
}
export function Spark({
  points,
  color = "#078990",
}: {
  points: Point[];
  color?: string;
}) {
  const { t } = useLinguiMacro();
  const values = points.slice(-60),
    max = Math.max(1, ...values.map((p) => p.value)),
    min = Math.min(0, ...values.map((p) => p.value));
  if (values.length < 2)
    return <span className="spark-empty">{t`等待采样`}</span>;
  const path = values
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"}${String((i / (values.length - 1)) * 100)},${String(26 - ((p.value - min) / (max - min)) * 24)}`,
    )
    .join(" ");
  return (
    <svg
      className="spark"
      viewBox="0 0 100 30"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth="1.8"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
export function TimeChart({
  series,
  unit,
  max,
  range,
  label,
}: {
  series: ChartSeries[];
  unit: string;
  max?: number | undefined;
  range?: [number, number] | undefined;
  label: string;
}) {
  const { i18n, t } = useLinguiMacro();
  const id = useId().replaceAll(":", "");
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900),
    [height, setHeight] = useState(215);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const box = element.querySelector("svg")?.getBoundingClientRect();
      if (box) {
        setWidth(Math.max(280, Math.round(box.width)));
        setHeight(Math.max(120, Math.round(box.height)));
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);
  const [hover, setHover] = useState<number | null>(null);
  const data = series.map((s) => ({
    ...s,
    points: orderedPoints(s.points),
  }));
  const all = data.flatMap((s) => s.points),
    hasData = all.length > 1;
  const to = range?.[1] ?? Math.max(60_000, ...all.map((p) => p.ts)),
    from = range?.[0] ?? Math.min(to - 60_000, ...all.map((p) => p.ts));
  const ceiling = max ?? Math.max(1, ...all.map((p) => p.value)) * 1.15;
  const W = width,
    H = height,
    L = 52,
    R = 15,
    T = 18,
    B = 34,
    iw = W - L - R,
    ih = H - T - B;
  const x = (ts: number) => L + ((ts - from) / Math.max(1, to - from)) * iw,
    y = (v: number) => T + ih - Math.min(1, Math.max(0, v / ceiling)) * ih;
  const tickLabel = (ts: number) =>
    to - from < 300_000
      ? new Date(ts).toLocaleTimeString(i18n.locale, {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
      : timeLabel(ts);
  const activeTs = hover === null ? null : from + hover * (to - from);
  const nearest = data.map((s) => ({
    ...s,
    point:
      activeTs === null
        ? undefined
        : s.points.reduce<Point | undefined>(
            (best, p) =>
              !best || Math.abs(p.ts - activeTs) < Math.abs(best.ts - activeTs)
                ? p
                : best,
            undefined,
          ),
  }));
  return (
    <div className="time-chart" ref={ref}>
      <svg
        viewBox={`0 0 ${String(W)} ${String(H)}`}
        role="img"
        aria-label={t`${label}，${String(data.length)} 条序列`}
        onPointerMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          setHover(
            Math.min(
              1,
              Math.max(
                0,
                (((event.clientX - box.left) / box.width) * W - L) / iw,
              ),
            ),
          );
        }}
        onPointerLeave={() => {
          setHover(null);
        }}
      >
        <defs>
          {data.map((s, i) => (
            <linearGradient
              key={s.name}
              id={`${id}-${String(i)}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0%" stopColor={s.color} stopOpacity=".14" />
              <stop offset="100%" stopColor={s.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        {[0, 0.25, 0.5, 0.75, 1].map((v) => (
          <g key={v}>
            <line
              x1={L}
              x2={W - R}
              y1={y(v * ceiling)}
              y2={y(v * ceiling)}
              className="chart-grid"
            />
            <text
              x={L - 12}
              y={y(v * ceiling) + 4}
              textAnchor="end"
              className="chart-label"
            >
              {unit === "B"
                ? metricValue(v * ceiling, "B")
                : String(Math.round(v * ceiling))}
            </text>
          </g>
        ))}
        {[0, 0.25, 0.5, 0.75, 1].map((v) => (
          <text
            key={v}
            x={L + v * iw}
            y={H - 6}
            textAnchor={v === 0 ? "start" : v === 1 ? "end" : "middle"}
            className="chart-label"
          >
            {tickLabel(from + v * (to - from))}
          </text>
        ))}
        {data.map((s, i) => {
          if (s.points.length < 2) return null;
          const gapLimit = Math.max(30_000, (to - from) / 20);
          const breaks = s.points.map(
            (p, index) =>
              index === 0 ||
              p.ts - (s.points[index - 1]?.ts ?? p.ts) > gapLimit,
          );
          const discontinuous = breaks.slice(1).some(Boolean);
          const segments = s.points
            .map(
              (p, index) =>
                `${breaks[index] ? "M" : "L"}${String(x(p.ts))},${String(y(p.value))}`,
            )
            .join(" ");
          const first = s.points[0],
            end = s.points.at(-1);
          return (
            <g key={s.name}>
              {data.length === 1 && !discontinuous && first && end ? (
                <path
                  d={`${segments} L${String(x(end.ts))},${String(T + ih)} L${String(x(first.ts))},${String(T + ih)} Z`}
                  fill={`url(#${id}-${String(i)})`}
                />
              ) : null}
              <path
                d={segments}
                fill="none"
                stroke={s.color}
                strokeWidth="2.2"
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </g>
          );
        })}
        {hover !== null && hasData ? (
          <g>
            <line
              x1={L + hover * iw}
              x2={L + hover * iw}
              y1={T}
              y2={T + ih}
              className="chart-crosshair"
            />
            {nearest.map((s) =>
              s.point ? (
                <circle
                  key={s.name}
                  cx={x(s.point.ts)}
                  cy={y(s.point.value)}
                  r={4}
                  fill={s.color}
                  className="chart-dot"
                />
              ) : null,
            )}
          </g>
        ) : null}
      </svg>
      {!hasData ? (
        <div className="chart-no-data">
          <span>{t`暂无可用的采样数据`}</span>
          <small>{t`采集结果到达后，趋势会出现在这里`}</small>
        </div>
      ) : null}
      <div className="chart-legend">
        {nearest.map((s) => (
          <span key={s.name}>
            <i
              style={{
                background: s.color,
              }}
            />
            {s.name}
            <strong>
              {s.point
                ? metricValue(s.point.value, unit)
                : s.points.at(-1)
                  ? metricValue(s.points.at(-1)?.value ?? 0, unit)
                  : "—"}
            </strong>
          </span>
        ))}
        {activeTs !== null ? (
          <time>{timeLabel(activeTs)}</time>
        ) : (
          <small>
            {unit === "%"
              ? t`纵轴 0–100%`
              : unit === "B"
                ? t`内存 / 容量以二进制单位显示`
                : unit}
          </small>
        )}
      </div>
    </div>
  );
}
