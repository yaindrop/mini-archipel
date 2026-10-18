import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLingui } from "@lingui/react";
import { useLingui as useLinguiMacro } from "@lingui/react/macro";
import {
  Alert,
  Button,
  Drawer,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Typography,
  type TableColumnsType,
} from "antd";
import { ListFilter, Plus, RotateCcw, Trash2 } from "lucide-react";
import type { Host } from "../contracts.ts";
import { displayName } from "../domain.ts";
import { api, message } from "./api.ts";
import { CLASSES, classification } from "./storage-classes.ts";
import {
  DirectoryRuleSchema,
  directoryRuleRows,
  ruleKey,
  type DirectoryRule,
  type DiskRulesConfig,
  type DiskRulesView,
  type RuleRow,
} from "../storage-rules.ts";

export function DirectoryRules({
  host,
  disabled,
}: {
  host: Host;
  disabled: boolean;
}) {
  const { t } = useLinguiMacro();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        icon={<ListFilter size={15} />}
        disabled={disabled}
        onClick={() => {
          setOpen(true);
        }}
      >{t`目录规则`}</Button>
      {open ? (
        <RulesDrawer
          host={host.name}
          label={displayName(host)}
          onClose={() => {
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}
function RulesDrawer({
  host,
  label,
  onClose,
}: {
  host: string;
  label: string;
  onClose: () => void;
}) {
  const { t } = useLinguiMacro();
  const { _ } = useLingui();
  const query = useQuery({
    queryKey: ["disk-rules", host],
    queryFn: () => api.diskRules(host),
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  if (query.data)
    return (
      <RulesEditor
        key={`${query.data.revision}:${String(query.dataUpdatedAt)}`}
        host={host}
        label={label}
        view={query.data}
        onClose={onClose}
        loadError={query.error}
        reload={() => query.refetch()}
      />
    );
  return (
    <Drawer open title={t`目录规则 · ${label}`} onClose={onClose} size={1040}>
      {query.isError ? (
        <Alert
          type="error"
          showIcon
          title={message(query.error, _)}
          action={
            <Button onClick={() => void query.refetch()}>{t`重试`}</Button>
          }
        />
      ) : (
        <Spin />
      )}
    </Drawer>
  );
}
function RulesEditor({
  host,
  label,
  view,
  onClose,
  reload,
  loadError,
}: {
  host: string;
  label: string;
  view: DiskRulesView;
  onClose: () => void;
  reload: () => Promise<unknown>;
  loadError: unknown;
}) {
  const { t } = useLinguiMacro();
  const { _ } = useLingui();
  const [modal, contextHolder] = Modal.useModal();
  const [base, setBase] = useState(view);
  const [config, setConfig] = useState(view.config);
  const [filter, setFilter] = useState("");
  const [adding, setAdding] = useState(false);
  const [form] = Form.useForm<DirectoryRule>();
  const [saved, setSaved] = useState(false);
  const dirty = JSON.stringify(base.config) !== JSON.stringify(config);
  const rows = directoryRuleRows(base, config);
  const mutation = useMutation({
    mutationFn: () =>
      api.saveDiskRules(host, { revision: base.revision, config }),
    onSuccess(result) {
      setBase(result);
      setConfig(result.config);
      setSaved(true);
    },
  });
  const change = (next: DiskRulesConfig) => {
    if (mutation.isPending) return;
    setConfig(next);
    setSaved(false);
    mutation.reset();
  };
  const close = () => {
    if (mutation.isPending) return;
    if (!dirty) onClose();
    else
      modal.confirm({
        title: t`放弃未保存的目录规则？`,
        okText: t`放弃修改`,
        cancelText: t`继续编辑`,
        onOk: onClose,
      });
  };
  const remove = (row: RuleRow) => {
    change({
      ...config,
      rules: config.rules.filter(
        (rule) => ruleKey(rule.path, base.home) !== row.key,
      ),
    });
  };
  const edit = (
    row: RuleRow,
    field: "depth" | "class",
    value: number | string,
  ) => {
    const rule = {
      path: row.path,
      depth: row.override?.depth ?? null,
      class: row.override?.class ?? null,
      [field]: value === "inherit" ? null : value,
    } as DirectoryRule;
    const rest = config.rules.filter(
      (rule) => ruleKey(rule.path, base.home) !== row.key,
    );
    change({
      ...config,
      rules:
        rule.depth === null && rule.class === null && row.base
          ? rest
          : [...rest, rule],
    });
  };
  const classOptions = [
    { value: "inherit", label: t`继承分类` },
    ...Object.keys(CLASSES).map((value) => ({
      value,
      label: _(classification(value).label),
    })),
  ];
  const depthOptions = [
    { value: "inherit", label: t`继承深度` },
    ...[0, 1, 2, 3, 4].map((value) => ({
      value,
      label: value === 0 ? t`0 · 不预取` : t`${value} 层`,
    })),
  ];
  const columns: TableColumnsType<RuleRow> = [
    {
      title: t`路径与来源`,
      key: "path",
      width: 380,
      render: (_value: unknown, row) => (
        <div className="directory-rule-path">
          <code>{row.path}</code>
          <Space size={4} wrap>
            {row.origin === "default" ? <Tag>{t`默认`}</Tag> : null}
            {row.plugins.map((plugin) => (
              <Tag key={plugin} color="processing">
                {t`插件`} · {plugin}
              </Tag>
            ))}
            {row.override ? <Tag color="success">{t`自定义`}</Tag> : null}
          </Space>
        </div>
      ),
    },
    {
      title: t`下钻深度`,
      key: "depth",
      width: 160,
      render: (_value: unknown, row) => (
        <Select
          disabled={mutation.isPending}
          virtual={false}
          aria-label={t`${row.path} 下钻深度`}
          value={row.override?.depth ?? row.base?.depth ?? "inherit"}
          options={depthOptions}
          onChange={(value) => {
            edit(row, "depth", value);
          }}
        />
      ),
    },
    {
      title: t`分类`,
      key: "class",
      width: 170,
      render: (_value: unknown, row) => (
        <Select
          disabled={mutation.isPending}
          virtual={false}
          aria-label={t`${row.path} 分类`}
          value={row.override?.class ?? row.base?.class ?? "inherit"}
          options={classOptions}
          onChange={(value) => {
            edit(row, "class", value);
          }}
        />
      ),
    },
    {
      title: t`操作`,
      key: "actions",
      width: 100,
      render: (_value: unknown, row) =>
        row.override ? (
          <Button
            type="text"
            disabled={mutation.isPending}
            icon={row.base ? <RotateCcw size={14} /> : <Trash2 size={14} />}
            aria-label={row.base ? t`恢复 ${row.path}` : t`删除 ${row.path}`}
            onClick={() => {
              remove(row);
            }}
          >
            {row.base ? t`恢复` : t`删除`}
          </Button>
        ) : null,
    },
  ];
  return (
    <Drawer
      open
      title={t`目录规则 · ${label}`}
      onClose={close}
      size={1040}
      className="directory-rules-drawer"
      footer={
        <div className="directory-rules-footer">
          <Typography.Text type="secondary">
            {dirty ? t`有未保存的修改` : t`规则已与节点同步`}
          </Typography.Text>
          <Space>
            <Button
              onClick={close}
              disabled={mutation.isPending}
            >{t`关闭`}</Button>
            <Button
              type="primary"
              disabled={!dirty}
              loading={mutation.isPending}
              onClick={() => {
                mutation.mutate();
              }}
            >{t`保存到节点`}</Button>
          </Space>
        </div>
      }
    >
      {contextHolder}
      <Space vertical size="middle" className="directory-rules-content">
        <Typography.Paragraph type="secondary">{t`规则只影响此节点。保存后从下一次扫描生效，当前扫描和已有结果会保留。深度为 0 时不预取下级目录，仍可按需展开。分类用于展示，不会自动删除文件。`}</Typography.Paragraph>
        {mutation.isError || loadError ? (
          <Alert
            type="error"
            showIcon
            title={message(loadError ?? mutation.error, _)}
            action={
              <Popconfirm
                title={t`放弃未保存的修改并重新载入？`}
                onConfirm={() => {
                  void reload();
                }}
              >
                <Button>{t`重新载入规则`}</Button>
              </Popconfirm>
            }
          />
        ) : saved ? (
          <Alert
            type="success"
            showIcon
            title={t`目录规则已保存，下次扫描生效。`}
          />
        ) : null}
        <div className="directory-rules-toolbar">
          <Space>
            <Switch
              checked={config.use_defaults}
              aria-label={t`启用默认规则`}
              onChange={(checked) => {
                change({ ...config, use_defaults: checked });
              }}
              disabled={mutation.isPending}
            />
            <span>{t`启用默认规则`}</span>
          </Space>
          <Space wrap>
            <Popconfirm
              title={t`恢复此节点的默认目录规则？`}
              description={t`将删除所有自定义规则和覆盖，保留已启用插件的规则。保存到节点后生效。`}
              onConfirm={() => {
                change({ use_defaults: true, rules: [] });
              }}
            >
              <Button
                icon={<RotateCcw size={14} />}
                disabled={mutation.isPending}
              >{t`恢复默认`}</Button>
            </Popconfirm>
            <Button
              icon={<Plus size={14} />}
              disabled={mutation.isPending || config.rules.length >= 128}
              onClick={() => {
                form.resetFields();
                setAdding(true);
              }}
            >{t`添加规则`}</Button>
          </Space>
        </div>
        <Input.Search
          aria-label={t`筛选规则路径`}
          placeholder={t`筛选规则路径`}
          allowClear
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
          }}
        />
        <Table<RuleRow>
          rowKey="key"
          size="small"
          columns={columns}
          dataSource={rows.filter((row) =>
            row.path.toLowerCase().includes(filter.toLowerCase()),
          )}
          pagination={{
            pageSize: 10,
            showSizeChanger: false,
            hideOnSinglePage: true,
          }}
          scroll={{ x: 810 }}
          loading={mutation.isPending}
        />
        <Typography.Text type="secondary">{t`自定义字段优先于默认和插件规则；未指定的字段继承原规则或上级目录。恢复某条规则只移除该路径的自定义覆盖。`}</Typography.Text>
      </Space>
      <Modal
        open={adding}
        title={t`添加目录规则`}
        okText={t`添加`}
        cancelText={t`取消`}
        onCancel={() => {
          setAdding(false);
        }}
        onOk={() => {
          form.submit();
        }}
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{ depth: 1, class: "user" }}
          onFinish={(rule) => {
            change({ ...config, rules: [...config.rules, rule] });
            setAdding(false);
            setFilter(rule.path);
          }}
        >
          <Form.Item
            name="path"
            label={t`目录路径`}
            rules={[
              {
                validator: (_rule, value: unknown) => {
                  if (
                    typeof value !== "string" ||
                    !DirectoryRuleSchema.safeParse({ path: value }).success
                  )
                    return Promise.reject(
                      Error(
                        t`请输入绝对路径或 ~/ 开头的路径，不允许 .. 或控制字符`,
                      ),
                    );
                  if (rows.some((row) => row.key === ruleKey(value, base.home)))
                    return Promise.reject(
                      Error(t`此路径已有规则，请直接编辑对应行`),
                    );
                  return Promise.resolve();
                },
              },
            ]}
          >
            <Input placeholder="~/Library/Caches" autoComplete="off" />
          </Form.Item>
          <Form.Item name="depth" label={t`下钻深度`}>
            <Select
              disabled={mutation.isPending}
              virtual={false}
              options={depthOptions.filter(
                (option) => option.value !== "inherit",
              )}
            />
          </Form.Item>
          <Form.Item name="class" label={t`分类`}>
            <Select
              disabled={mutation.isPending}
              virtual={false}
              options={classOptions.filter(
                (option) => option.value !== "inherit",
              )}
            />
          </Form.Item>
        </Form>
      </Modal>
    </Drawer>
  );
}
