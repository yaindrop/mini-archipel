import { useLingui } from "@lingui/react/macro";
import { Button, Space, Table, Tag, Typography } from "antd";
export interface PermissionCheck {
  key: string;
  label: string;
  status:
    | "unchecked"
    | "required"
    | "waiting"
    | "verified"
    | "error"
    | "not-required";
  checkedAt?: number | null | undefined;
  detail?: string | null | undefined;
  busy?: boolean;
  canCheck: boolean;
  canRequest: boolean;
  requestLabel?: string;
  onCheck: () => void;
  onRequest: () => void;
}
export function PermissionChecks({
  node,
  items,
}: {
  node: string;
  items: PermissionCheck[];
}) {
  const { t } = useLingui();
  const labels = {
    unchecked: t`未检查`,
    required: t`待授权`,
    waiting: t`等待本人确认`,
    verified: t`已验证可用`,
    error: t`检测失败`,
    "not-required": t`无需额外授权`,
  };
  return (
    <>
      <Typography.Paragraph type="secondary">{t`目标节点：${node}`}</Typography.Paragraph>
      <Table<PermissionCheck>
        size="small"
        rowKey="key"
        dataSource={items}
        pagination={false}
        scroll={{ x: 580 }}
        columns={[
          { title: t`权限`, dataIndex: "label" },
          {
            title: t`状态`,
            key: "status",
            render: (_, row) => (
              <Tag
                color={
                  row.status === "verified"
                    ? "success"
                    : row.status === "waiting"
                      ? "processing"
                      : row.status === "required"
                        ? "warning"
                        : row.status === "error"
                          ? "error"
                          : "default"
                }
              >
                {labels[row.status]}
              </Tag>
            ),
          },
          {
            title: t`最近检测`,
            key: "checked",
            render: (_, row) => (
              <span title={row.detail ?? undefined}>
                {row.checkedAt
                  ? new Date(row.checkedAt).toLocaleString()
                  : t`未检查`}
              </span>
            ),
          },
          { title: t`说明`, dataIndex: "detail" },
          {
            title: t`操作`,
            key: "actions",
            render: (_, row) => (
              <Space wrap>
                <Button
                  size="small"
                  disabled={!row.canCheck}
                  loading={Boolean(row.busy)}
                  aria-label={`${row.label} · ${t`重新检查`}`}
                  onClick={row.onCheck}
                >{t`重新检查`}</Button>
                <Button
                  size="small"
                  disabled={!row.canRequest}
                  aria-label={`${row.label} · ${row.requestLabel ?? t`请求授权`}`}
                  onClick={row.onRequest}
                >
                  {row.requestLabel ?? t`请求授权`}
                </Button>
              </Space>
            ),
          },
        ]}
      />
    </>
  );
}
