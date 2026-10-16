import { useState } from "react";

interface ScanNode {
  root: string;
  class: string;
  bytes: number;
  children: ScanNode[];
  ts: number;
  duration_ms: number;
  partial: boolean;
}

const CLASS_COLORS: Record<string, string> = {
  system: "#30363d",
  apps: "#3fb950",
  user: "#58a6ff",
  reclaimable: "#d29922",
  toolchain: "#f0883e",
  agentic: "#f0883e",
  library: "#8957e5",
  other: "#6e7681",
  skipped: "#21262d",
};

/** Human-readable size: picks B/K/M/G/T. */
const fmtSize = (bytes: number): string => {
  const abs = Math.abs(bytes);
  if (abs >= 2 ** 40) return `${(bytes / 2 ** 40).toFixed(2)}T`;
  if (abs >= 2 ** 30) return `${(bytes / 2 ** 30).toFixed(1)}G`;
  if (abs >= 2 ** 20) return `${(bytes / 2 ** 20).toFixed(1)}M`;
  if (abs >= 1024) return `${(bytes / 1024).toFixed(0)}K`;
  return `${bytes}B`;
};
const fmtGiB = fmtSize;

/** Exactly two levels: ~ first-level dirs, plus github-runners' repos. */
function flatten(
  node: ScanNode,
  _depth: number,
  rows: Array<{ depth: number; node: ScanNode }>,
): void {
  rows.push({ depth: 0, node });
  const sorted = [...node.children].sort((a, b) => b.bytes - a.bytes);
  for (const child of sorted) {
    rows.push({ depth: 1, node: child });
    // Apps' children go directly under the Applications row, not at the bottom.
    if (child.root === "Applications" && child.children.length > 0) {
      const subs = [...child.children].sort((a, b) => b.bytes - a.bytes);
      for (const sub of subs) {
        rows.push({ depth: 2, node: sub });
      }
    }
  }
}

export function DiskPanel({
  scans,
  host,
}: {
  scans: ScanNode[];
  host: string;
}) {
  const [scanning, setScanning] = useState(false);
  const [scanNotice, setScanNotice] = useState<string | null>(null);

  const triggerRescan = async () => {
    setScanning(true);
    setScanNotice(null);
    try {
      const token = localStorage.getItem("fleet-token") ?? "";
      const response = await fetch("/api/disk/rescan", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : undefined),
        },
        body: JSON.stringify({ host }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
      };
      setScanNotice(
        payload.ok
          ? "已触发重新扫描"
          : `失败: ${payload.error ?? response.status}`,
      );
    } catch (error) {
      setScanNotice(`失败: ${error instanceof Error ? error.message : error}`);
    } finally {
      setScanning(false);
    }
  };

  if (scans.length === 0) return null;
  return (
    <div className="disk-panel">
      <div className="panel-title">
        存储容量明细
        <button
          className="runner-toggle"
          style={{ marginLeft: "12px" }}
          disabled={scanning}
          onClick={triggerRescan}
          title="立即重新扫描磁盘（遇 CPU 峰值会延后半小时）"
        >
          {scanning ? "触发中…" : "立即扫描"}
        </button>
        {scanNotice ? <span className="muted"> {scanNotice}</span> : null}
      </div>
      {scans.map((scan) => {
        const rows: Array<{ depth: number; node: ScanNode }> = [];
        flatten(scan, 0, rows);
        const total = scan.bytes;
        return (
          <div key={scan.root} className="disk-tree">
            <div className="disk-head">
              {scan.root} · {fmtGiB(total)}
              {scan.partial ? " · 部分扫描" : ""} · 扫描耗时{" "}
              {(scan.duration_ms / 1000).toFixed(0)}s
            </div>
            <div className="disk-bar">
              {(() => {
                const totals = new Map<string, number>();
                const collect = (n: ScanNode) => {
                  for (const c of n.children) {
                    totals.set(c.class, (totals.get(c.class) ?? 0) + c.bytes);
                    collect(c);
                  }
                };
                collect(scan);
                return [...totals.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .map(([cls, bytes]) => (
                    <div
                      key={cls}
                      className="disk-seg"
                      style={{
                        width: `${Math.max((bytes / total) * 100, 0.5)}%`,
                        background: CLASS_COLORS[cls] ?? "#6e7681",
                      }}
                      title={`${cls} ${fmtGiB(bytes)}`}
                    />
                  ));
              })()}
            </div>
            <table className="proc-table">
              <tbody>
                {rows.slice(1, 20).map(({ depth, node }) => (
                  <tr key={`${depth}-${node.root}-${node.bytes}`}>
                    <td style={{ paddingLeft: depth * 14 }}>
                      <span
                        className="disk-dot"
                        style={{
                          background: CLASS_COLORS[node.class] ?? "#6e7681",
                        }}
                      />
                      {node.root}
                    </td>
                    <td className="num">{fmtGiB(node.bytes)}</td>
                    <td className="num muted">{node.class}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}
