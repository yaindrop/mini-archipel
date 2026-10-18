import { useLingui } from "@lingui/react/macro";
import { useLayoutEffect, useRef, useState } from "react";
import type { Policy, FanState } from "./contracts.ts";
import { withProtectionTemperature } from "./domain.ts";

/** The daemon holds each step; a sloping line would misrepresent its behavior. */
export function Curve({
  policy,
  applied,
  runtime,
  onChange,
}: {
  policy: Policy;
  applied: Policy;
  runtime: FanState["telemetry"];
  onChange: (policy: Policy) => void;
}) {
  const { t } = useLingui();
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      setWidth(Math.max(280, node.clientWidth));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);
  const w = width,
    h = 280,
    left = 58,
    right = 24,
    top = 24,
    bottom = 40;
  const xmin = 20,
    xmax = 100;
  const ymax = Math.max(policy.max_rpm, applied.max_rpm) * 1.08;
  const x = (v: number) =>
    left +
    ((Math.max(xmin, Math.min(xmax, v)) - xmin) / (xmax - xmin)) *
      (w - left - right);
  const y = (v: number) => h - bottom - (v / ymax) * (h - top - bottom);
  // At the minimum command the daemon returns control to the SMC; zero on
  // this chart denotes system control, not a commanded stop.
  const shownRpm = (rpm: number, p: Policy) => (rpm <= p.min_rpm + 1 ? 0 : rpm);
  const wave = (from: number, to: number) => {
    const count = Math.max(1, Math.ceil((to - from) / 8));
    return Array.from({ length: count }, (_, i) => {
      const end = from + ((i + 1) / count) * (to - from);
      const middle = from + ((i + 0.5) / count) * (to - from);
      return `Q${String(middle)},${String(y(0) + (i % 2 ? 4 : -4))} ${String(end)},${String(y(0))}`;
    }).join(" ");
  };
  const path = (p: Policy) =>
    p.curve
      .map((point, i) => {
        const start = x(point.t),
          end = x(p.curve[i + 1]?.t ?? p.critical_temp);
        const rpm = shownRpm(point.rpm, p);
        return `${i ? "V" : `M${String(start)},`}${String(y(rpm))} ${rpm === 0 ? wave(start, end) : `H${String(end)}`}`;
      })
      .join(" ") + ` V${String(y(p.max_rpm))} H${String(x(xmax))}`;
  const drag = useRef<number | null>(null);
  const edit = (index: number, temperature: number, rpm: number) => {
    const current = policy.curve[index],
      previous = policy.curve[index - 1],
      next = policy.curve[index + 1];
    if (!current || !previous) return;
    if (!next) {
      onChange(withProtectionTemperature(policy, Math.round(temperature)));
      return;
    }
    const low = Math.max(xmin, previous.t + 1),
      high = Math.min(policy.critical_temp, next.t - 1);
    if (low > high) return;
    onChange({
      ...policy,
      curve: policy.curve.map((p, i) =>
        i === index
          ? {
              t: Math.max(low, Math.min(high, Math.round(temperature))),
              rpm: Math.max(
                previous.rpm,
                Math.min(next.rpm, Math.round(rpm / 50) * 50),
              ),
            }
          : p,
      ),
    });
  };
  const live = runtime?.runtime;
  return (
    <div className="fan-curve" ref={ref}>
      {/* biome-ignore lint/a11y/useSemanticElements: This SVG groups keyboard-operable curve points; HTML fieldset is not an SVG element. */}
      <svg
        viewBox={`0 0 ${String(w)} ${String(h)}`}
        role="group"
        onPointerMove={(event) => {
          if (drag.current === null) return;
          const box = event.currentTarget.getBoundingClientRect();
          edit(
            drag.current,
            ((((event.clientX - box.left) / box.width) * w - left) /
              (w - left - right)) *
              (xmax - xmin) +
              xmin,
            ((h - bottom - ((event.clientY - box.top) / box.height) * h) /
              (h - top - bottom)) *
              ymax,
          );
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        aria-label={t`风扇阶梯曲线：温度与目标转速`}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((v) => (
          <g key={v}>
            <line
              x1={left}
              x2={w - right}
              y1={y(v * ymax)}
              y2={y(v * ymax)}
              className="chart-grid"
            />
            <text
              x={left - 10}
              y={y(v * ymax) + 4}
              textAnchor="end"
              className="chart-label"
            >
              {Math.round(v * ymax)}
            </text>
          </g>
        ))}
        {[20, 40, 60, 80, 100].map((v) => (
          <text
            key={v}
            x={x(v)}
            y={h - 12}
            textAnchor="middle"
            className="chart-label"
          >
            {v} °C
          </text>
        ))}
        <text x={left} y={14} className="chart-label">
          RPM
        </text>
        <rect
          x={x(policy.critical_temp)}
          y={top}
          width={x(xmax) - x(policy.critical_temp)}
          height={h - top - bottom}
          className="fan-danger-zone"
        />
        <path d={path(applied)} className="fan-curve-applied" />
        <path d={path(policy)} className="fan-curve-draft" />
        {policy.curve.map((p, i) => (
          // biome-ignore lint/a11y/useSemanticElements: SVG curve handles cannot be HTML buttons; numeric inputs provide the same edits.
          <circle
            key={i}
            cx={x(p.t)}
            cy={y(shownRpm(p.rpm, policy))}
            r={i === 0 ? 4 : 6}
            className="fan-curve-point"
            role="button"
            aria-disabled={i === 0}
            tabIndex={i === 0 ? -1 : 0}
            aria-label={
              i === policy.curve.length - 1
                ? t`调整保护温度：拖动或使用左右方向键`
                : t`调整第 ${String(i + 1)} 档：拖动或使用方向键`
            }
            onPointerDown={
              i === 0
                ? undefined
                : (event) => {
                    drag.current = i;
                    event.currentTarget.ownerSVGElement?.setPointerCapture(
                      event.pointerId,
                    );
                    event.preventDefault();
                  }
            }
            onKeyDown={
              i === 0
                ? undefined
                : (event) => {
                    if (
                      ![
                        "ArrowUp",
                        "ArrowDown",
                        "ArrowLeft",
                        "ArrowRight",
                      ].includes(event.key)
                    )
                      return;
                    event.preventDefault();
                    edit(
                      i,
                      p.t +
                        (event.key === "ArrowRight"
                          ? 1
                          : event.key === "ArrowLeft"
                            ? -1
                            : 0),
                      p.rpm +
                        (event.key === "ArrowUp"
                          ? 50
                          : event.key === "ArrowDown"
                            ? -50
                            : 0),
                    );
                  }
            }
          />
        ))}
        {live?.control_temp !== null && live?.control_temp !== undefined ? (
          <g>
            <line
              x1={x(live.control_temp)}
              x2={x(live.control_temp)}
              y1={top}
              y2={h - bottom}
              className="chart-crosshair"
            />
            <circle
              cx={x(live.control_temp)}
              cy={y(shownRpm(live.command_rpm, applied))}
              r={6}
              className="fan-curve-live"
            />
          </g>
        ) : null}
      </svg>
      <div className="fan-curve-legend">
        <span>{t`实线：草稿`}</span>
        <span>{t`虚线：已应用`}</span>
        <span>{t`波浪线：系统默认（转速由系统决定）`}</span>
        <span>{t`阴影：达到保护温度时使用最高转速`}</span>
        <span>{t`圆点：守护进程当前状态`}</span>
      </div>
    </div>
  );
}
