import { useState } from "react";

export type SortDir = "asc" | "desc";

export interface Column<T> {
  key: string;
  label: string;
  align?: "left" | "right";
  render: (item: T) => React.ReactNode;
  sortValue: (item: T) => string | number;
  default?: boolean;
}

/** Click-to-sort table with zero dependencies. */
export function SortableTable<T>({
  items,
  columns,
  initialSortKey,
  initialDir = "desc",
  className = "proc-table",
  rowKey,
}: {
  items: T[];
  columns: Column<T>[];
  initialSortKey?: string;
  initialDir?: SortDir;
  className?: string;
  rowKey: (item: T) => string;
}) {
  const [sortKey, setSortKey] = useState(
    initialSortKey ??
      columns.find((c) => c.default)?.key ??
      columns[0]?.key ??
      "",
  );
  const [dir, setDir] = useState<SortDir>(initialDir);

  const sorted = [...items].sort((a, b) => {
    const col = columns.find((c) => c.key === sortKey);
    if (!col) return 0;
    const av = col.sortValue(a);
    const bv = col.sortValue(b);
    const cmp =
      typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av).localeCompare(String(bv));
    return dir === "asc" ? cmp : -cmp;
  });

  const toggle = (key: string) => {
    if (key === sortKey) {
      setDir(dir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setDir("desc");
    }
  };

  return (
    <table className={className}>
      <thead>
        <tr>
          {columns.map((col) => (
            <th
              key={col.key}
              onClick={() => toggle(col.key)}
              style={{
                cursor: "pointer",
                userSelect: "none",
                textAlign: col.align ?? "left",
              }}
              title={`按${col.label}排序`}
            >
              {col.label}
              {sortKey === col.key ? (dir === "asc" ? " ↑" : " ↓") : ""}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.map((item) => (
          <tr key={rowKey(item)}>
            {columns.map((col) => (
              <td key={col.key} className={col.align === "right" ? "num" : ""}>
                {col.render(item)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
