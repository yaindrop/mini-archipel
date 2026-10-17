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

const fmtSize = (bytes: number): string => {
  const abs = Math.abs(bytes);
  if (abs >= 2 ** 40) return `${(bytes / 2 ** 40).toFixed(2)}T`;
  if (abs >= 2 ** 30) return `${(bytes / 2 ** 30).toFixed(1)}G`;
  if (abs >= 2 ** 20) return `${(bytes / 2 ** 20).toFixed(1)}M`;
  if (abs >= 1024) return `${(bytes / 1024).toFixed(0)}K`;
  return `${bytes}B`;
};
const fmtGiB = fmtSize;

function flatten(
  node: ScanNode,
  _depth: number,
  rows: Array<{ depth: number; node: ScanNode }>,
): void {
  rows.push({ depth: 0, node });
  const sorted = [...node.children].sort((a, b) => b.bytes - a.bytes);
  for (const child of sorted) {
    rows.push({ depth: 1, node: child });
    if (child.root === "Applications" && child.children.length > 0) {
      const subs = [...child.children].sort((a, b) => b.bytes - a.bytes);
      for (const sub of subs) {
        rows.push({ depth: 2, node: sub });
      }
    }
  }
}

type Row = { depth: number; node: ScanNode };
interface Group { parent: Row; children: Row[] }
type SortKey = "name" | "size" | "class";
type SortDir = "asc" | "desc";

function buildGroups(items: Row[]): Group[] {
  const groups: Group[] = [];
  for (const row of items) {
    if (row.depth <= 1) groups.push({ parent: row, children: [] });
    else if (groups.length > 0) groups[groups.length - 1]!.children.push(row);
  }
  return groups;
}

function sortValue(row: Row, key: SortKey): string | number {
  if (key === "size") return row.node.bytes;
  if (key === "name") return row.node.root;
  return row.node.class;
}

function SortableTreeTable({ items }: { items: Row[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("size");
  const [dir, setDir] = useState<SortDir>("desc");
  const groups = buildGroups(items);
  const cmp = (a: Row, b: Row) => {
    const av = sortValue(a, sortKey);
    const bv = sortValue(b, sortKey);
    const c = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
    return dir === "asc" ? c : -c;
  };
  groups.sort((a, b) => cmp(a.parent, b.parent));
  for (const g of groups) g.children.sort(cmp);
  const toggle = (key: SortKey) => {
    if (key === sortKey) setDir(dir === "asc" ? "desc" : "asc");
    else { setSortKey(key); setDir("desc"); }
  };
  return (
    <table className="proc-table">
      <thead>
        <tr>
          {([["name","目录","left"],["size","大小","right"],["class","类别","right"]] as const).map(([key,label,align]) => (
            <th key={key} onClick={() => toggle(key)} style={{ cursor:"pointer",userSelect:"none",textAlign:align }}>
              {label}{sortKey===key?(dir==="asc"?" ↑":" ↓"):""}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {groups.map((g) => (
          <RowGroup key={`${g.parent.depth}-${g.parent.node.root}-${g.parent.node.bytes}`} group={g} />
        ))}
      </tbody>
    </table>
  );
}

function RowGroup({ group }: { group: Group }) {
  const [collapsed, setCollapsed] = useState(false);
  const hasChildren = group.children.length > 0;
  const { parent } = group;
  return (
    <>
      <tr onClick={hasChildren ? () => setCollapsed(!collapsed) : undefined} style={hasChildren ? { cursor:"pointer" } : undefined}>
        <td style={{ paddingLeft: parent.depth * 14 }}>
          <span className="disk-dot" style={{ background: CLASS_COLORS[parent.node.class] ?? "#6e7681" }} />
          {hasChildren ? <span className="muted">{collapsed ? "▸ " : "▾ "}</span> : ""}
          {parent.node.root}
        </td>
        <td className="num">{fmtGiB(parent.node.bytes)}</td>
        <td className="num muted">{parent.node.class}</td>
      </tr>
      {!collapsed && group.children.map((child) => (
        <tr key={`${child.depth}-${child.node.root}-${child.node.bytes}`}>
          <td style={{ paddingLeft: child.depth * 14 }}>
            <span className="disk-dot" style={{ background: CLASS_COLORS[child.node.class] ?? "#6e7681" }} />
            {child.node.root}
          </td>
          <td className="num">{fmtGiB(child.node.bytes)}</td>
          <td className="num muted">{child.node.class}</td>
        </tr>
      ))}
    </>
  );
}

export function DiskPanel({ scans, host }: { scans: ScanNode[]; host: string }) {
  const [scanning, setScanning] = useState(false);
  const [scanNotice, setScanNotice] = useState<string | null>(null);
  const triggerRescan = async () => {
    setScanning(true); setScanNotice(null);
    try {
      const token = localStorage.getItem("fleet-token") ?? "";
      const response = await fetch("/api/disk/rescan", {
        method: "POST",
        headers: { "content-type":"application/json", ...(token ? { authorization: `Bearer ${token}` } : undefined) },
        body: JSON.stringify({ host }),
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string };
      setScanNotice(payload.ok ? "已触发重新扫描" : `失败: ${payload.error ?? response.status}`);
    } catch (error) {
      setScanNotice(`失败: ${error instanceof Error ? error.message : error}`);
    } finally { setScanning(false); }
  };
  if (scans.length === 0) return null;
  return (
    <div className="disk-panel">
      <div className="panel-title">
        存储容量明细
        <button className="runner-toggle" style={{ marginLeft:"12px" }} disabled={scanning} onClick={triggerRescan} title="立即重新扫描磁盘">
          {scanning ? "触发中…" : "立即扫描"}
        </button>
        {scanNotice ? <span className="muted"> {scanNotice}</span> : null}
      </div>
      {scans.map((scan) => {
        const rows: Row[] = [];
        flatten(scan, 0, rows);
        const total = scan.bytes;
        return (
          <div key={scan.root} className="disk-tree">
            <div className="disk-head">
              {scan.root} · {fmtGiB(total)}
              {scan.partial ? " · 部分扫描" : ""} · 扫描耗时 {(scan.duration_ms / 1000).toFixed(0)}s
            </div>
            <div className="disk-bar">
              {(() => {
                const totals = new Map<string, number>();
                const collect = (n: ScanNode) => { for (const c of n.children) { totals.set(c.class,(totals.get(c.class) ?? 0)+c.bytes); collect(c); } };
                collect(scan);
                return [...totals.entries()].sort((a,b)=>b[1]-a[1]).map(([cls,bytes]) => (
                  <div key={cls} className="disk-seg" style={{ width:`${Math.max((bytes/total)*100,0.5)}%`, background:CLASS_COLORS[cls] ?? "#6e7681" }} title={`${cls} ${fmtGiB(bytes)}`} />
                ));
              })()}
            </div>
            <SortableTreeTable items={rows.slice(1)} />
          </div>
        );
      })}
    </div>
  );
}
