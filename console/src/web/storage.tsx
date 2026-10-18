import { useLingui } from "@lingui/react";
import { useLingui as useLinguiMacro } from "@lingui/react/macro";
import { useState } from "react";
import { useSearchParams, Link } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { refreshFleet } from "./useFleet.ts";
import {
  Alert,
  Button,
  Card,
  Empty,
  Progress,
  Segmented,
  Space,
  Statistic,
  Table,
  Tag,
  Spin,
  Typography,
  type TableColumnsType,
} from "antd";
import { Folder, HardDrive, RefreshCw } from "lucide-react";
import type { Fleet, Host, ScanNode } from "../contracts.ts";
import {
  dataDisk,
  displayName,
  formatBytes,
  stale,
  storageClasses,
  timeLabel,
} from "../domain.ts";
import { api, message } from "./api.ts";
import { classification } from "./storage-classes.ts";
import { DirectoryRules } from "./storage-rules.tsx";
import { PageTitle, Section } from "./ui.tsx";
type DirectoryRow = Omit<ScanNode, "children"> & {
  key: string;
  path: string;
  detail?: boolean;
  children?: DirectoryRow[];
};
function directoryRows(
  nodes: ScanNode[],
  root: string,
  parent = "",
): DirectoryRow[] {
  return nodes.map(({ children, ...node }) => {
    const key = `${parent}/${node.root}`,
      path = `${root === "/" ? "" : root}${key}`;
    const pending = ["unscanned", "unreadable", "partial"].includes(
      node.children_status,
    );
    return {
      ...node,
      key,
      path,
      ...(children.length
        ? { children: directoryRows(children, root, key) }
        : pending
          ? {
              children: [
                { ...node, key: `${key}/__scan__`, path, detail: true },
              ],
            }
          : {}),
    };
  });
}
export function StorageBrowser({ host, now }: { host: Host; now: number }) {
  const { t } = useLinguiMacro();
  const { _ } = useLingui();
  const [activeClass, setActiveClass] = useState<string | null>(null);
  const highlight = (key: string) => ({
    className: activeClass === key ? "is-active" : "",
    onMouseEnter() {
      setActiveClass(key);
    },
    onMouseLeave() {
      setActiveClass(null);
    },
    onFocus() {
      setActiveClass(key);
    },
    onBlur() {
      setActiveClass(null);
    },
    onClick() {
      setActiveClass(key);
    },
  });
  const [search, setSearch] = useSearchParams(),
    scans = (host.snapshot?.disk_scans ?? []).toSorted(
      (a, b) =>
        Number(a.root === "/") - Number(b.root === "/") ||
        a.root.localeCompare(b.root),
    );
  const scan = scans.find((s) => s.root === search.get("root")) ?? scans[0];
  const update = (root: string) => {
    const next = new URLSearchParams(search);
    next.set("root", root);
    next.delete("dir");
    setSearch(next, {
      replace: true,
    });
  };
  const client = useQueryClient();
  const job = host.snapshot?.disk_scan;
  const waiting =
    job && ["queued", "running", "cancelling"].includes(job.status);
  const mutation = useMutation({
    mutationFn: (action: { cancel?: boolean; path?: string }) =>
      action.cancel && job
        ? api.cancelScan(host.name, job.id)
        : api.rescan(host.name, action.path),
    onSuccess: () => refreshFleet(client),
  });
  const classes = scan ? storageClasses(scan) : new Map<string, number>(),
    total = scan?.bytes ?? 0;
  const columns: TableColumnsType<DirectoryRow> = [
    {
      title: t`目录`,
      key: "name",
      rowScope: "row",
      sorter: (a, b) => a.root.localeCompare(b.root),
      onCell: (node) => (node.detail ? { colSpan: 4 } : {}),
      render: (_value: unknown, node) =>
        node.detail ? (
          <div className="directory-scan-detail">
            {waiting && job.target === node.path ? <Spin size="small" /> : null}
            <Typography.Text type="secondary">
              {waiting && job.target === node.path
                ? t`正在后台扫描此目录，保留上次结果`
                : node.children_status === "unreadable"
                  ? t`此目录不可读取，未将其视为空目录。`
                  : t`尚未扫描下级目录`}
            </Typography.Text>
            <Button
              size="small"
              disabled={
                stale(host, now) || Boolean(waiting) || mutation.isPending
              }
              onClick={() => {
                mutation.mutate({ path: node.path });
              }}
            >
              {node.children_status === "unreadable"
                ? t`重试扫描`
                : t`扫描此目录`}
            </Button>
          </div>
        ) : (
          <div className="directory-name">
            <Space className="folder-label">
              <Folder size={16} />
              <span>{node.root}</span>
            </Space>
            {node.children_status === "unreadable" ? (
              <Typography.Text type="warning">{t`不可读取`}</Typography.Text>
            ) : node.partial ? (
              <Typography.Text type="warning">{t`部分不可读取`}</Typography.Text>
            ) : null}
            {node.children_status === "complete" &&
            node.bytes === 0 &&
            !node.children?.length ? (
              <Typography.Text type="secondary">{t`无子目录`}</Typography.Text>
            ) : null}
          </div>
        ),
    },
    {
      title: t`用途`,
      key: "class",
      onCell: (node) => (node.detail ? { colSpan: 0 } : {}),
      responsive: ["sm"],
      render: (_v: unknown, node) => {
        const cls = classification(node.class);
        return (
          <Space size={6}>
            <i
              className="class-dot"
              style={{
                background: cls.color,
              }}
            />
            {_(cls.label)}
          </Space>
        );
      },
    },
    {
      title: t`占当前目录`,
      key: "proportion",
      onCell: (node) => (node.detail ? { colSpan: 0 } : {}),
      responsive: ["md"],
      render: (_v: unknown, node) => (
        <div className="size-proportion">
          <Progress
            percent={total ? (node.bytes / total) * 100 : 0}
            showInfo={false}
            size="small"
            aria-label={t`${node.root} 空间比例`}
          />
          <span className="num">
            {(total ? (node.bytes / total) * 100 : 0).toFixed(1)}%
          </span>
        </div>
      ),
    },
    {
      title: t`大小`,
      key: "bytes",
      onCell: (node) => (node.detail ? { colSpan: 0 } : {}),
      align: "right",
      defaultSortOrder: "descend",
      sorter: (a, b) => a.bytes - b.bytes,
      render: (_v: unknown, node) => (
        <span className="num">
          {node.children_status === "unreadable"
            ? "—"
            : formatBytes(node.bytes)}
        </span>
      ),
    },
  ];
  return (
    <Section
      title={t`目录空间分析`}
      subtitle={t`按目录与用途定位空间占用，扫描完成后自动更新。`}
      action={
        <Space wrap>
          <DirectoryRules host={host} disabled={stale(host, now)} />
          {waiting ? (
            <Button
              danger
              disabled={stale(host, now) || job.status === "cancelling"}
              loading={mutation.isPending && Boolean(mutation.variables.cancel)}
              onClick={() => {
                mutation.mutate({ cancel: true });
              }}
            >
              {job.status === "cancelling" ? t`取消中…` : t`取消扫描`}
            </Button>
          ) : null}
          <Button
            icon={<RefreshCw size={15} />}
            loading={mutation.isPending && !mutation.variables.cancel}
            disabled={stale(host, now) || Boolean(waiting)}
            onClick={() => {
              mutation.mutate({});
            }}
          >
            {waiting
              ? t`扫描中…`
              : mutation.isPending
                ? t`提交中…`
                : t`重新扫描`}
          </Button>
        </Space>
      }
    >
      {mutation.isError ? (
        <Alert
          type="error"
          showIcon
          title={message(mutation.error, _)}
          role="alert"
        />
      ) : waiting ? (
        <Alert
          type="info"
          showIcon
          role="status"
          title={
            job.status === "queued"
              ? t`扫描已排队`
              : job.status === "cancelling"
                ? t`正在取消扫描`
                : t`正在后台扫描，保留上次结果`
          }
          description={
            job.current_root ? <code>{job.current_root}</code> : undefined
          }
        />
      ) : job?.status === "cancelled" ? (
        <Alert
          type="info"
          showIcon
          title={t`扫描已取消，保留上次结果。`}
          role="status"
        />
      ) : job?.status === "interrupted" ? (
        <Alert
          type="warning"
          showIcon
          title={t`上次扫描因节点重启而中断，保留上次结果。`}
          role="status"
        />
      ) : job?.status === "failed" ? (
        <Alert
          type="error"
          showIcon
          title={t`扫描失败，保留上次结果。`}
          description={job.error}
          role="alert"
        />
      ) : null}
      {!scan ? (
        <Empty
          description={t`尚无目录扫描结果，点击重新扫描开始采集目录空间。`}
        />
      ) : (
        <>
          <Segmented
            className="storage-roots"
            aria-label={t`扫描范围`}
            value={scan.root}
            options={scans.map((s) => ({
              value: s.root,
              label: (
                <span className="storage-root-label">
                  <span className="storage-root-icon" aria-hidden="true">
                    <span>{s.root === "/" ? "/" : "~"}</span>
                  </span>
                  <span>
                    {s.root === "/"
                      ? t`系统根目录`
                      : s.root.startsWith("/Users/")
                        ? t`用户目录`
                        : s.root}
                  </span>
                </span>
              ),
            }))}
            onChange={(value) => {
              update(value);
            }}
          />
          <div className="storage-breakdown">
            <div className="storage-total">
              <Statistic
                title={t`已统计目录`}
                value={scan.bytes}
                formatter={() => formatBytes(scan.bytes)}
              />
              <Typography.Text type="secondary">{t`${scan.partial ? t`部分目录不可读取 · ` : ""}${timeLabel(scan.ts)} 更新 · 耗时 ${(scan.duration_ms / 1000).toFixed(1)} 秒`}</Typography.Text>
            </div>
            <div>
              <div
                className="storage-bar"
                role="img"
                aria-label={t`目录分类，共 ${formatBytes(scan.bytes)}`}
              >
                {[...classes].map(([key, bytes]) => (
                  <span
                    key={key}
                    aria-hidden="true"
                    className={activeClass === key ? "is-active" : ""}
                    onPointerEnter={() => {
                      setActiveClass(key);
                    }}
                    onPointerLeave={() => {
                      setActiveClass(null);
                    }}
                    style={{
                      width: `${String(scan.bytes ? (bytes / scan.bytes) * 100 : 0)}%`,
                      background: classification(key).color,
                    }}
                  />
                ))}
              </div>
              <div className="storage-legend">
                {[...classes].map(([key, bytes]) => (
                  <Button
                    key={key}
                    type="text"
                    {...highlight(key)}
                    style={
                      activeClass === key
                        ? {
                            color: "var(--panel)",
                            background: "var(--text)",
                          }
                        : undefined
                    }
                  >
                    <i
                      style={{
                        background: classification(key).color,
                      }}
                    />
                    {_(classification(key).label)}
                    <strong>{formatBytes(bytes)}</strong>
                  </Button>
                ))}
              </div>
            </div>
          </div>
          <div className="directory-toolbar">
            <Typography.Text className="storage-root-path" type="secondary">
              {scan.root}
            </Typography.Text>
            {search.getAll("dir").length ? (
              <Button
                type="text"
                size="small"
                disabled={
                  stale(host, now) || Boolean(waiting) || mutation.isPending
                }
                onClick={() => {
                  const key = search.getAll("dir").at(-1);
                  if (key)
                    mutation.mutate({
                      path: `${scan.root === "/" ? "" : scan.root}${key}`,
                    });
                }}
              >{t`重新扫描展开目录`}</Button>
            ) : null}
          </div>
          <Table<DirectoryRow>
            key={`${host.name}:${scan.root}`}
            className="storage-table"
            rowKey="key"
            columns={columns}
            dataSource={directoryRows(scan.children, scan.root)}
            expandable={{
              rowExpandable: (row) =>
                !row.detail && Boolean(row.children?.length),
              expandedRowKeys: search.getAll("dir"),
              onExpand: (expanded, row) => {
                const next = new URLSearchParams(search);
                const keys = new Set(next.getAll("dir"));
                if (expanded) keys.add(row.key);
                else keys.delete(row.key);
                next.delete("dir");
                for (const key of keys) next.append("dir", key);
                setSearch(next, { replace: true });
                if (
                  expanded &&
                  row.children_status === "unscanned" &&
                  !row.children?.some((child) => !child.detail) &&
                  !waiting &&
                  !mutation.isPending
                )
                  mutation.mutate({ path: row.path });
              },
            }}
            pagination={false}
            size="middle"
            locale={{
              emptyText: (
                <Empty
                  description={t`此范围暂无已采集的目录。点击重新扫描获取目录明细。`}
                />
              ),
            }}
          />
          <div className="panel-footnote">{t`目录统计与 APFS 卷容量的计算口径不同；“可重建缓存”只表示分类，不会自动删除数据。`}</div>
        </>
      )}
    </Section>
  );
}
export function Storage({ fleet, now }: { fleet: Fleet; now: number }) {
  const { t } = useLinguiMacro();
  const [search, setSearch] = useSearchParams(),
    host =
      fleet.hosts.find((h) => h.name === search.get("host")) ?? fleet.hosts[0];
  return (
    <>
      <PageTitle
        eyebrow={t`STORAGE`}
        title={t`存储空间`}
        description={t`先看卷容量，再沿目录定位占用。清晰区分物理容量与目录统计。`}
      />
      <div className="storage-volume-grid">
        {fleet.hosts.map((h) => {
          const disk = dataDisk(h),
            pct = disk
              ? (1 - disk.available_bytes / Math.max(1, disk.total_bytes)) * 100
              : 0,
            selected = host?.name === h.name;
          return (
            <Card
              key={h.name}
              className={`volume-card ${selected ? "selected" : ""}`}
              title={
                <Space className="volume-name">
                  <HardDrive size={17} />
                  {displayName(h)}
                </Space>
              }
              extra={
                stale(h, now) ? <Tag color="error">{t`数据过期`}</Tag> : null
              }
            >
              <Button
                type="text"
                className="volume-select"
                aria-label={t`查看 ${displayName(h)} 的存储空间`}
                aria-pressed={selected}
                onClick={() => {
                  setSearch(
                    {
                      host: h.name,
                    },
                    {
                      replace: true,
                    },
                  );
                }}
              />
              <Statistic
                value={0}
                formatter={() => formatBytes(disk?.available_bytes)}
                suffix={
                  <Typography.Text type="secondary">{t`可用`}</Typography.Text>
                }
              />
              <Progress
                percent={pct}
                showInfo={false}
                size="small"
                {...(disk && disk.available_bytes < 40 * 2 ** 30
                  ? {
                      strokeColor: "#b17a24",
                    }
                  : {})}
                aria-label={t`${displayName(h)} 卷已用比例`}
              />
              <div className="volume-caption">
                <span>{t`已用${" "} ${formatBytes(disk ? disk.total_bytes - disk.available_bytes : undefined)}`}</span>
                <span>{t`共 ${formatBytes(disk?.total_bytes)}`}</span>
              </div>
            </Card>
          );
        })}
      </div>
      {host ? (
        <StorageBrowser key={host.name} host={host} now={now} />
      ) : (
        <Empty description={t`尚未配置节点`} />
      )}
      <div className="page-note">
        {t` 可用容量低于 40 GiB 时显示提醒。`}
        <Link to="/">{t`返回集群概览`}</Link>
      </div>
    </>
  );
}
