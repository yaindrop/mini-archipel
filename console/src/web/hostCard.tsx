import { DiskPanel } from "./diskPanel.tsx";
import { HistoryView } from "./historyView.tsx";
import { RunnerPanel } from "./runnerPanel.tsx";
import { Spark } from "./spark.tsx";

interface HostView {
  name: string;
  online: boolean;
  lastError: string | null;
  lastTs: number;
  snapshot: any;
  history: Record<string, Array<{ ts: number; value: number }>>;
}

const fmtBytes = (bytes: number | undefined): string => {
  if (typeof bytes !== "number") return "—";
  const gib = bytes / 2 ** 30;
  return `${gib.toFixed(1)} GiB`;
};

const fmtUptime = (seconds: number | undefined): string => {
  if (typeof seconds !== "number") return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
};

const THERMAL_LABELS = ["nominal", "fair", "serious", "critical"];

/** 12-core mini bars: E cores first (sysinfo order), height = usage. */
function CoreBars({ cores }: { cores: number[] }) {
  if (!cores?.length) return null;
  const eCount = Math.max(1, Math.round(cores.length / 3));
  return (
    <div className="core-bars">
      {cores.map((usage, index) => (
        <div
          key={index}
          className="core-bar"
          title={`Core ${index} (${index < eCount ? "E" : "P"}) ${usage.toFixed(0)}%`}
        >
          <div
            className="core-fill"
            style={{
              height: `${Math.min(usage, 100)}%`,
              background:
                index < eCount ? "#58a6ff" : usage > 80 ? "#f85149" : "#d29922",
            }}
          />
        </div>
      ))}
    </div>
  );
}

export function HostCard({ host }: { host: HostView }) {
  const snapshot = host.snapshot ?? {};
  const sys = snapshot.sys ?? {};
  const hostInfo = snapshot.host ?? {};
  const macmon = snapshot.macmon;
  const thermal = snapshot.thermal;
  const fan = snapshot.fan;
  const dataDisk = (sys.disks ?? []).find(
    (disk: any) => disk.mount === "/System/Volumes/Data",
  );
  const diskAvailGiB = dataDisk ? dataDisk.available_bytes / 2 ** 30 : null;
  const memPct = sys.mem
    ? Math.round((sys.mem.used_bytes / sys.mem.total_bytes) * 100)
    : null;

  const cpuHistory = host.history["cpu.usage_pct"] ?? [];
  const memHistory = host.history["mem.used_bytes"] ?? [];
  const freqHistory = host.history["cpu.p_freq_mhz"] ?? [];
  const fanHistory = host.history["fan.rpm"] ?? [];

  return (
    <div className={`host-card${host.online ? "" : " offline"}`}>
      <div className="host-title">
        <span className="name">
          {host.online ? "🟢" : "🔴"} {host.name}
        </span>
        <span className="meta">
          {hostInfo.model} · up {fmtUptime(hostInfo.uptime_s)} · load{" "}
          {Array.isArray(hostInfo.load) ? hostInfo.load[0]?.toFixed(2) : "—"}
          {!host.online && host.lastError ? ` · ${host.lastError}` : ""}
        </span>
      </div>

      <div className="metric-grid">
        <div className="metric">
          <div className="label">CPU</div>
          <div className="value">
            {sys.cpu ? `${sys.cpu.usage_pct.toFixed(1)}%` : "—"}
          </div>
          <div className="sub">
            {macmon?.p_cluster_mhz ? `P ${macmon.p_cluster_mhz} MHz` : ""}{" "}
            {macmon?.e_cluster_mhz ? `E ${macmon.e_cluster_mhz} MHz` : ""}
          </div>
          <CoreBars cores={sys.cpu?.cores ?? []} />
          <Spark points={cpuHistory} color="#58a6ff" max={100} />
        </div>
        <div className="metric">
          <div className="label">内存</div>
          <div className="value">{memPct !== null ? `${memPct}%` : "—"}</div>
          <div className="sub">
            {sys.mem
              ? `${fmtBytes(sys.mem.used_bytes)} / ${fmtBytes(sys.mem.total_bytes)}`
              : ""}
          </div>
          <Spark
            points={memHistory}
            color="#3fb950"
            max={sys.mem?.total_bytes ?? undefined}
          />
        </div>
        <div className="metric">
          <div className="label">存储容量</div>
          <div
            className={`value${diskAvailGiB !== null && diskAvailGiB < 40 ? " critical" : ""}`}
          >
            {diskAvailGiB !== null ? `${diskAvailGiB.toFixed(0)} GiB` : "—"}
          </div>
          <div className="sub">
            {diskAvailGiB !== null && diskAvailGiB < 40
              ? "低于 40G 水位线"
              : "水位线 40G"}
          </div>
        </div>
        <div className="metric">
          <div className="label">GPU</div>
          <div className="value">
            {macmon ? `${(macmon.gpu_pct ?? 0).toFixed(0)}%` : "—"}
          </div>
          <div className="sub">
            {macmon?.gpu_mhz ? `${macmon.gpu_mhz} MHz` : ""}
          </div>
        </div>
        <div className="metric">
          <div className="label">功耗</div>
          <div className="value">
            {macmon ? `${(macmon.package_power_w ?? 0).toFixed(1)} W` : "—"}
          </div>
          <div className="sub">
            {macmon ? `CPU ${(macmon.cpu_power_w ?? 0).toFixed(1)} W` : ""}
          </div>
          <Spark points={freqHistory} color="#d29922" />
        </div>
        <div className="metric">
          <div className="label">
            风扇{fan ? ` · ${Number(fan.temp).toFixed(1)}°C` : ""}
          </div>
          <div className="value">{fan ? `${fan.rpm} RPM` : "—"}</div>
          <div className="sub">
            {thermal ? (
              <span
                className={
                  thermal.state >= 2
                    ? "critical"
                    : thermal.state === 1
                      ? "warn"
                      : ""
                }
              >
                {THERMAL_LABELS[thermal.state] ?? "?"}
              </span>
            ) : (
              ""
            )}
            {fan?.forced === false ? " · 已交回系统" : ""}
          </div>
          <Spark points={fanHistory} color="#f778ba" />
        </div>
      </div>

      <RunnerPanel
        runners={(snapshot.runners ?? []) as any[]}
        ghRunners={(host as any).ghRunners ?? null}
        host={host.name}
        token={localStorage.getItem("fleet-token") ?? ""}
        workerBusy={(snapshot.runners ?? []).some((r: any) => r.worker_pid)}
      />
      <DiskPanel
        scans={((snapshot.disk_scans ?? []) as any[]).sort(
          (a: any, b: any) =>
            (a.root.includes("Users") ? -1 : 1) -
            (b.root.includes("Users") ? -1 : 1),
        )}
        host={host.name}
      />

      <HistoryView host={host.name} />

      <table className="proc-table">
        <thead>
          <tr>
            <th>活跃进程</th>
            <th style={{ textAlign: "right" }}>CPU%</th>
            <th style={{ textAlign: "right" }}>内存</th>
          </tr>
        </thead>
        <tbody>
          {(sys.procs ?? []).map((proc: any) => (
            <tr key={proc.pid}>
              <td title={proc.name}>{proc.name.slice(0, 28)}</td>
              <td className="num">{proc.cpu_pct.toFixed(1)}</td>
              <td className="num">{fmtBytes(proc.mem_bytes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
