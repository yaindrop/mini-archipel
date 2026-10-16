import { useEffect, useRef, useState } from "react";

export interface HistoryPoint {
  ts: number;
  value: number;
}

const SERIES: Array<{ key: string; label: string; unit: string }> = [
  { key: "cpu.usage_pct", label: "CPU 占用", unit: "%" },
  { key: "mem.used_bytes", label: "内存已用", unit: "B" },
  { key: "disk.data_available_bytes", label: "磁盘可用", unit: "B" },
  { key: "fan.rpm", label: "风扇转速", unit: "RPM" },
];

const WINDOWS: Array<{ label: string; ms: number }> = [
  { label: "10 分钟", ms: 600_000 },
  { label: "1 小时", ms: 3_600_000 },
  { label: "24 小时", ms: 86_400_000 },
];

function fmtValue(value: number, unit: string): string {
  if (unit === "B") return `${(value / 2 ** 30).toFixed(1)} GiB`;
  return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
}

export function HistoryView({ host }: { host: string }) {
  const token = localStorage.getItem("fleet-token") ?? "";
  const [open, setOpen] = useState(false);
  const [windowMs, setWindowMs] = useState(3_600_000);
  const [data, setData] = useState<Record<string, HistoryPoint[]>>({});

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = async () => {
      const next: Record<string, HistoryPoint[]> = {};
      for (const series of SERIES) {
        try {
          const response = await fetch(
            `/api/history?host=${encodeURIComponent(host)}&key=${series.key}&windowMs=${windowMs}`,
            {
              headers: token ? { authorization: `Bearer ${token}` } : undefined,
            },
          );
          if (!response.ok) continue;
          const payload = (await response.json()) as { points: HistoryPoint[] };
          next[series.key] = payload.points ?? [];
        } catch {
          /* keep other series */
        }
      }
      if (!cancelled) setData(next);
    };
    void load();
    const timer = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open, host, windowMs, token]);

  return (
    <div className="history-view">
      <button className="history-toggle" onClick={() => setOpen(!open)}>
        {open ? "收起历史曲线" : "历史曲线"}
      </button>
      {open ? (
        <>
          <div className="history-windows">
            {WINDOWS.map((w) => (
              <button
                key={w.ms}
                className={w.ms === windowMs ? "active" : ""}
                onClick={() => setWindowMs(w.ms)}
              >
                {w.label}
              </button>
            ))}
          </div>
          <div className="history-grid">
            {SERIES.map((series) => (
              <div key={series.key} className="history-cell">
                <div className="label">
                  {series.label} · {(data[series.key] ?? []).length} 点
                </div>
                <div className="spark-large">
                  <HistorySpark
                    points={data[series.key] ?? []}
                    unit={series.unit}
                  />
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}
      <span className="hidden-format">{fmtValue(0, "B")}</span>
    </div>
  );
}

function HistorySpark({
  points,
  unit,
}: {
  points: HistoryPoint[];
  unit: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    context.scale(ratio, ratio);
    context.clearRect(0, 0, width, height);
    if (points.length < 2) return;
    const hi = Math.max(...points.map((p) => p.value));
    const lo = Math.min(...points.map((p) => p.value));
    const span = hi === lo ? 1 : hi - lo;
    const stepX = width / (points.length - 1);
    const y = (value: number) =>
      height - 4 - ((value - lo) / span) * (height - 8);
    context.beginPath();
    points.forEach((point, index) => {
      const px = index * stepX;
      const py = y(point.value);
      if (index === 0) context.moveTo(px, py);
      else context.lineTo(px, py);
    });
    context.strokeStyle = "#58a6ff";
    context.lineWidth = 1.2;
    context.stroke();
    context.strokeStyle = "#30363d";
    context.beginPath();
    context.moveTo(0, y(hi));
    context.lineTo(width, y(hi));
    context.moveTo(0, y(lo));
    context.lineTo(width, y(lo));
    context.stroke();
    context.fillStyle = "#8b949e";
    context.font = "10px -apple-system";
    context.fillText(fmtValue(hi, unit), 4, 10);
    context.fillText(fmtValue(lo, unit), 4, height - 4);
  }, [points, unit]);
  return <canvas ref={canvasRef} className="spark-large" />;
}
