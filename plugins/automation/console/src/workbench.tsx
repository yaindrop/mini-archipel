import {
  InputInfoSchema,
  InputRequestSchema,
  InputStopSchema,
} from "./input-contracts.ts";
import { useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Descriptions,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import { Link, useSearchParams } from "react-router";
import type { Host } from "../../../../console/src/contracts.ts";
import type { WorkspaceProps } from "../../../../console/src/web/plugins.tsx";
import { displayName } from "../../../../console/src/domain.ts";
import {
  NodePager,
  PageTitle,
  Section,
} from "../../../../console/src/web/ui.tsx";
import { api, message } from "../../../../console/src/web/api.ts";
import { refreshArchipel } from "../../../../console/src/web/useArchipel.ts";
import { active, desktopCurrent, desktopData } from "./domain.ts";
import {
  DiagnosticReplySchema,
  JobReplySchema,
  JobRequestSchema,
  StateReplySchema,
  type DesktopData,
  type DesktopJob,
  type JobRequest,
} from "./contracts.ts";

import {
  PermissionChecks,
  type PermissionCheck,
} from "../../../../console/src/web/permission-checks.tsx";

function download(report: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "desktop-diagnostics.json";
  anchor.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}

export function DesktopAutomation({ archipel, now }: WorkspaceProps) {
  const { t } = useLingui(),
    [search, setSearch] = useSearchParams();
  const host =
    archipel.hosts.find((item) => item.name === search.get("host")) ??
    archipel.hosts[0];
  return (
    <>
      <PageTitle
        title={t`桌面自动化`}
        description={t`在节点本机运行脚本、操作聊天应用，查看授权与后台任务。`}
      />
      <NodePager
        hosts={archipel.hosts}
        now={now}
        selected={host?.name}
        onSelect={(name) => {
          const next = new URLSearchParams(search);
          next.set("host", name);
          next.delete("job");
          setSearch(next, { replace: true });
        }}
        label={(item) => t`选择 ${displayName(item)}`}
        primary={(item) => {
          const toolkit = desktopData(item)?.toolkit;
          if (!toolkit) return "—";
          return String(toolkit.jobs.filter((job) => active(job)).length);
        }}
        secondary={(item) => {
          const toolkit = desktopData(item)?.toolkit;
          if (!toolkit) return t`工具包未就绪`;
          if (toolkit.desktop_busy) return t`任务正在使用桌面`;
          if (toolkit.paused) return t`已暂停接单`;
          return t`可接收任务`;
        }}
      />
      {host ? (
        <div id={host.name}>
          <NodeWorkspace key={host.name} host={host} now={now} />
        </div>
      ) : (
        <Empty description={t`暂无节点`} />
      )}
    </>
  );
}

function NodeWorkspace({ host, now }: { host: Host; now: number }) {
  const { t } = useLingui(),
    { message: toast } = App.useApp(),
    client = useQueryClient();
  const [search, setSearch] = useSearchParams();
  const state = desktopData(host),
    toolkit = state?.toolkit,
    current = desktopCurrent(host, now);
  const selected = search.get("job") ?? toolkit?.jobs[0]?.id;
  const job = useQuery({
    queryKey: ["desktop-job", host.name, selected],
    queryFn: () =>
      api.pluginAction(
        "automation",
        "get",
        { host: host.name, request_id: selected },
        JobReplySchema,
      ),
    enabled: Boolean(current && selected && state?.availability === "ready"),
    retry: false,
    refetchInterval: (query) =>
      query.state.data && active(query.state.data.job) ? 1000 : false,
  });
  const submit = useMutation({
    mutationFn: (request: JobRequest) =>
      api.pluginAction(
        "automation",
        "submit",
        { host: host.name, request },
        JobReplySchema,
      ),
    onSuccess: (reply) => {
      setSearch({ host: host.name, job: reply.job.id });
      client.setQueryData(["desktop-job", host.name, reply.job.id], reply);
      void refreshArchipel(client);
    },
    onError: (error) => {
      void toast.error(message(error));
    },
  });
  const coordinate = useMutation({
    mutationFn: (paused: boolean) =>
      api.pluginAction(
        "automation",
        "coordinate",
        { host: host.name, paused },
        StateReplySchema,
      ),
    onSuccess: () => {
      void refreshArchipel(client);
    },
    onError: (error) => {
      void toast.error(message(error));
    },
  });
  const inputStop = useMutation({
    mutationFn: (stopped: boolean) =>
      api.pluginAction(
        "automation",
        "input-stop",
        { host: host.name, stopped },
        InputStopSchema,
      ),
    onSuccess: () => {
      void refreshArchipel(client);
    },
    onError: (error) => {
      void toast.error(message(error));
    },
  });
  const wait = useMutation({
    mutationFn: (id: string) =>
      api.pluginAction(
        "automation",
        "wait",
        { host: host.name, request_id: id, timeout_ms: 1000 },
        JobReplySchema,
      ),
    onSuccess: (reply) => {
      client.setQueryData(["desktop-job", host.name, reply.job.id], reply);
      void refreshArchipel(client);
    },
    onError: (error) => {
      void toast.error(message(error));
    },
  });
  const cancel = useMutation({
    mutationFn: (id: string) =>
      api.pluginAction(
        "automation",
        "cancel",
        { host: host.name, request_id: id },
        JobReplySchema,
      ),
    onSuccess: () => {
      void refreshArchipel(client);
      void client.invalidateQueries({ queryKey: ["desktop-job", host.name] });
    },
    onError: (error) => {
      void toast.error(message(error));
    },
  });
  const diagnostics = useMutation({
    mutationFn: () =>
      api.pluginAction(
        "automation",
        "diagnostics",
        { host: host.name },
        DiagnosticReplySchema,
      ),
    onSuccess: (reply) => {
      download(reply.report);
    },
    onError: (error) => {
      void toast.error(message(error));
    },
  });
  const ready = current && state?.availability === "ready";
  const canSubmit = Boolean(
    ready &&
    toolkit?.installed &&
    !toolkit.paused &&
    !toolkit.desktop_busy &&
    !submit.isPending,
  );
  const request = (
    operation: "doctor" | "permissions",
    permission?: "accessibility" | "automation",
  ) => {
    const request_id = crypto.randomUUID();
    submit.mutate(
      operation === "doctor"
        ? { request_id, operation }
        : {
            request_id,
            operation,
            permission: permission ?? "accessibility",
            timeout: 180,
          },
    );
  };
  const labels: Record<DesktopJob["status"], string> = {
    queued: t`排队中`,
    running: t`运行中`,
    waiting_user: t`等待系统确认`,
    completed: t`已完成`,
    failed: t`失败`,
    cancelled: t`已取消`,
    interrupted: t`已中断`,
    needs_user: t`仍需授权`,
  };
  const permissionItems: PermissionCheck[] = (
    ["accessibility", "automation"] as const
  ).map((key) => {
    const value = toolkit?.permissions;
    const verified =
      key === "accessibility"
        ? value?.accessibility_verified
        : value?.automation_verified;
    const granted = value?.[key];
    const waiting = toolkit?.jobs.some(
      (item) =>
        item.operation === "permissions" &&
        item.permission === key &&
        item.status === "waiting_user",
    );
    return {
      key,
      label:
        key === "accessibility" ? t`辅助功能` : t`Apple Events / System Events`,
      status: verified
        ? "verified"
        : waiting
          ? "waiting"
          : value
            ? granted
              ? "error"
              : "required"
            : "unchecked",
      checkedAt: value ? value.checked_at * 1000 : null,
      canCheck: canSubmit,
      canRequest: canSubmit && Boolean(state?.control_allowed),
      busy: submit.isPending,
      onCheck: () => {
        request("doctor");
      },
      onRequest: () => {
        request("permissions", key);
      },
    };
  });
  return (
    <div className="desktop-workspace">
      {!current && (
        <Alert
          type="warning"
          showIcon
          title={t`节点或桌面插件未就绪`}
          description={<Link to="/plugins">{t`检查节点连接和插件开关`}</Link>}
        />
      )}
      {current && state?.availability !== "ready" && (
        <Alert
          type="info"
          showIcon
          title={t`请先在节点安装桌面工具包`}
          description={
            <>
              <p>{t`在节点上的 mini-archipel 仓库运行安装命令，然后刷新状态。`}</p>
              <code>python3 plugins/automation/install.py</code>
            </>
          }
        />
      )}
      <Section title={t`节点桌面`}>
        <Descriptions
          size="small"
          column={{ xs: 1, sm: 2, lg: 4 }}
          items={[
            {
              key: "companion",
              label: t`伴随应用`,
              children: toolkit?.permissions?.app_name ?? t`尚未检查`,
            },
            {
              key: "companion-path",
              label: t`应用路径`,
              children: (
                <Typography.Text copyable>
                  {toolkit?.permissions?.app_path ?? "—"}
                </Typography.Text>
              ),
            },
            {
              key: "owner",
              label: t`占用状态`,
              children: !toolkit
                ? t`工具包未就绪`
                : toolkit.desktop_busy
                  ? t`任务正在使用桌面`
                  : toolkit.paused
                    ? t`已暂停，可以人工接管`
                    : t`可接收任务`,
            },
            {
              key: "apps",
              label: t`应用安装`,
              children:
                [toolkit?.apps.codex && "Codex", toolkit?.apps.zcode && "ZCode"]
                  .filter(Boolean)
                  .join(" / ") || t`未检测到`,
            },
            {
              key: "session",
              label: t`桌面会话`,
              children:
                toolkit?.permissions?.console_session === undefined
                  ? t`尚未检查`
                  : toolkit.permissions.console_session
                    ? t`已登录`
                    : t`未登录`,
            },
            {
              key: "screen",
              label: t`屏幕`,
              children:
                toolkit?.permissions?.screen_locked == null
                  ? t`尚未检查`
                  : toolkit.permissions.screen_locked
                    ? t`已锁定`
                    : t`未锁定`,
            },
          ]}
        />
        {toolkit?.permissions && (
          <Typography.Paragraph type="secondary">{t`上次检查：${new Date(toolkit.permissions.checked_at * 1000).toLocaleString()}`}</Typography.Paragraph>
        )}
        {toolkit?.permissions?.screen_locked && (
          <Alert type="warning" title={t`节点屏幕已锁定，请先解锁`} />
        )}
        <PermissionChecks node={displayName(host)} items={permissionItems} />
        <Flex gap="small" wrap>
          {toolkit?.capabilities.includes("input") && (
            <Button
              aria-label={
                toolkit.input_stopped ? t`允许新的原生输入` : t`停止原生输入`
              }
              danger={!toolkit.input_stopped}
              disabled={!ready || !state.control_allowed}
              loading={inputStop.isPending}
              onClick={() => {
                inputStop.mutate(!toolkit.input_stopped);
              }}
            >
              {toolkit.input_stopped ? t`允许新的原生输入` : t`停止原生输入`}
            </Button>
          )}
          <Button
            disabled={!ready || !state.control_allowed}
            loading={coordinate.isPending}
            aria-label={toolkit?.paused ? t`恢复接单` : t`暂停接单`}
            onClick={() => {
              coordinate.mutate(!toolkit?.paused);
            }}
          >
            {toolkit?.paused ? t`恢复接单` : t`暂停接单`}
          </Button>
          <Button
            disabled={!ready}
            loading={diagnostics.isPending}
            aria-label={t`下载诊断包`}
            onClick={() => {
              diagnostics.mutate();
            }}
          >{t`下载诊断包`}</Button>
        </Flex>
        <Typography.Paragraph type="secondary">{t`授权窗口出现在节点机器上。请在那里完成密码、Touch ID 或允许操作；工具会复验，不保存密码。暂停接单后，等待当前任务结束或取消后再接管桌面。`}</Typography.Paragraph>
      </Section>
      {ready && toolkit && !toolkit.capabilities.includes("input") && (
        <Alert
          type="info"
          title={t`节点工具包尚不支持原生输入，请升级后重试`}
        />
      )}
      {toolkit?.capabilities.includes("input") && (
        <NativeInputForm
          host={host.name}
          ready={ready}
          canSubmit={canSubmit}
          control={Boolean(state?.control_allowed)}
          stopped={Boolean(toolkit.input_stopped)}
          pending={submit.isPending}
          onSubmit={(value) => {
            submit.mutate(value);
          }}
        />
      )}
      <div className="desktop-columns">
        <Section title={t`提交任务`}>
          {state && !state.control_allowed && (
            <Alert type="info" title={t`节点尚未启用桌面控制`} />
          )}
          <TaskForm
            host={host.name}
            state={state}
            disabled={!canSubmit || !state?.control_allowed}
            pending={submit.isPending}
            onSubmit={(value) => {
              submit.mutate(value);
            }}
          />
        </Section>
        <Section title={t`任务记录`}>
          <Table<DesktopJob>
            className="desktop-job-table"
            size="small"
            rowKey="id"
            dataSource={toolkit?.jobs ?? []}
            pagination={{ pageSize: 6, hideOnSinglePage: true }}
            scroll={{ x: 400 }}
            columns={[
              {
                title: t`任务`,
                key: "id",
                render: (_, row) => (
                  <Button
                    type="link"
                    className="desktop-job-link"
                    aria-pressed={selected === row.id}
                    title={row.id}
                    onClick={() => {
                      setSearch({ host: host.name, job: row.id });
                    }}
                  >
                    {row.operation} · {row.id}
                  </Button>
                ),
              },
              {
                title: t`状态`,
                dataIndex: "status",
                render: (value: DesktopJob["status"]) => (
                  <Tag>{labels[value]}</Tag>
                ),
              },
              {
                title: t`耗时`,
                key: "duration",
                render: (_, row) =>
                  `${Math.max(0, Math.round((active(row) ? now / 1000 : row.updated_at) - row.created_at)).toString()} s`,
              },
            ]}
          />
          {job.error && (
            <Alert type="error" showIcon title={message(job.error)} />
          )}
          {job.data && (
            <>
              <Flex justify="space-between" align="center" wrap gap="small">
                <Typography.Text copyable>{job.data.job.id}</Typography.Text>
                {active(job.data.job) && (
                  <Button
                    disabled={!current}
                    loading={wait.isPending}
                    onClick={() => {
                      wait.mutate(job.data.job.id);
                    }}
                  >{t`等待本次结果`}</Button>
                )}
                {active(job.data.job) && (
                  <Button
                    danger
                    disabled={!state?.control_allowed || !current}
                    loading={cancel.isPending}
                    aria-label={
                      job.data.job.operation === "chat"
                        ? t`停止等待`
                        : t`取消任务`
                    }
                    onClick={() => {
                      cancel.mutate(job.data.job.id);
                    }}
                  >
                    {job.data.job.operation === "chat"
                      ? t`停止等待`
                      : t`取消任务`}
                  </Button>
                )}
              </Flex>
              <Typography.Paragraph type="secondary">{t`取消不能撤回已发生的操作。超时或中断后，请先用原请求 ID 查询结果，原生输入不会自动重放。`}</Typography.Paragraph>
              <section aria-label={t`任务结果`}>
                <pre className="desktop-result">
                  {JSON.stringify(job.data.job, null, 2)}
                </pre>
              </section>
            </>
          )}
        </Section>
      </div>
    </div>
  );
}

function NativeInputForm({
  host,
  ready,
  canSubmit,
  control,
  stopped,
  pending,
  onSubmit,
}: {
  host: string;
  ready: boolean;
  canSubmit: boolean;
  control: boolean;
  stopped: boolean;
  pending: boolean;
  onSubmit: (request: JobRequest) => void;
}) {
  const { t } = useLingui();
  const [selection, setSelection] = useState<string>();
  const [action, setAction] = useState(
    '{"kind":"move","x":0,"y":0,"move_seconds":1}',
  );
  const [space, setSpace] = useState<"window" | "screen">("window");
  const [unit, setUnit] = useState<"points" | "pixels">("points");
  const [display, setDisplay] = useState<number>();
  const [timeout, setTimeoutValue] = useState(15);
  const [id, setId] = useState(() => crypto.randomUUID());
  const [error, setError] = useState("");
  const [hitText, setHitText] = useState(""),
    [hitRole, setHitRole] = useState("");
  const info = useMutation({
    mutationFn: () =>
      api.pluginAction("automation", "input-info", { host }, InputInfoSchema),
    onSuccess: () => {
      setSelection(undefined);
      setError("");
    },
  });
  const target = info.data?.windows.find(
    (window) =>
      `${String(window.pid)}:${String(window.window_id)}` === selection,
  );
  const send = (mode: "preflight" | "execute", activate = false) => {
    try {
      const request = InputRequestSchema.parse({
        request_id: `${id}${activate ? "-activate" : mode === "preflight" ? "-preflight" : ""}`,
        operation: "input",
        mode,
        timeout,
        target: target
          ? {
              ...target,
              ...(!activate && hitText ? { hit_text: hitText } : {}),
              ...(!activate && hitRole ? { hit_role: hitRole } : {}),
            }
          : undefined,
        coordinates: {
          space,
          unit,
          ...(unit === "pixels" ? { display_id: display } : {}),
        },
        action: activate
          ? { kind: "activate" }
          : (JSON.parse(action) as unknown),
      });
      setError("");
      onSubmit(request);
    } catch {
      setError(t`请检查窗口、动作 JSON、坐标单位和超时预算。`);
    }
  };
  return (
    <Section title={t`通用原生输入`}>
      <Typography.Paragraph type="secondary">{t`先刷新并选择真实窗口。刷新不会激活应用或请求权限；激活是独立操作。每次只提交一个动作，完成后请核对目标应用的实际响应。`}</Typography.Paragraph>
      <Button
        disabled={!ready}
        loading={info.isPending}
        onClick={() => {
          info.mutate();
        }}
      >{t`刷新应用与窗口`}</Button>
      {info.error && <Alert type="error" title={message(info.error)} />}
      {info.data && (
        <>
          <Typography.Paragraph>{t`辅助功能：${String(info.data.permissions.accessibility)}；事件发送：${String(info.data.permissions.post_events)}`}</Typography.Paragraph>
          {info.data.reason && <Alert type="info" title={info.data.reason} />}
          <Form layout="vertical">
            <Form.Item label={t`目标应用与窗口`}>
              <Select
                aria-label={t`目标应用与窗口`}
                value={selection}
                options={info.data.windows.map((window) => ({
                  value: `${String(window.pid)}:${String(window.window_id)}`,
                  label: `${info.data.applications.find((app) => app.pid === window.pid)?.name ?? window.bundle_id} · PID ${String(window.pid)} · ${String(window.window_id)}`,
                }))}
                onChange={setSelection}
              />
            </Form.Item>
            {target && (
              <Typography.Paragraph>
                {target.bundle_id} · {JSON.stringify(target.frame)} ·{" "}
                {new Date(target.observed_at_ms).toLocaleString()}
              </Typography.Paragraph>
            )}
            <Space wrap>
              <Form.Item label={t`坐标空间`}>
                <Select
                  aria-label={t`坐标空间`}
                  value={space}
                  options={[
                    { value: "window", label: t`窗口` },
                    { value: "screen", label: t`屏幕` },
                  ]}
                  onChange={setSpace}
                />
              </Form.Item>
              <Form.Item label={t`坐标单位`}>
                <Select
                  aria-label={t`坐标单位`}
                  value={unit}
                  options={[
                    { value: "points", label: t`屏幕点` },
                    { value: "pixels", label: t`实际像素` },
                  ]}
                  onChange={setUnit}
                />
              </Form.Item>
              {unit === "pixels" && (
                <Form.Item label={t`显示器`}>
                  <Select
                    aria-label={t`显示器`}
                    value={display}
                    options={info.data.displays.map((item) => ({
                      value: item.id,
                      label: `${String(item.id)} · ${String(item.pixel_width)} × ${String(item.pixel_height)}`,
                    }))}
                    onChange={setDisplay}
                  />
                </Form.Item>
              )}
              <Form.Item label={t`超时秒数`}>
                <InputNumber
                  aria-label={t`超时秒数`}
                  min={1}
                  max={120}
                  value={timeout}
                  onChange={(value) => {
                    setTimeoutValue(value ?? 15);
                  }}
                />
              </Form.Item>
            </Space>
            <Form.Item label={t`预期控件文字（可选，仅指针动作）`}>
              <Input
                aria-label={t`预期控件文字（可选，仅指针动作）`}
                maxLength={1000}
                value={hitText}
                onChange={(event) => {
                  setHitText(event.target.value);
                }}
              />
            </Form.Item>
            <Form.Item label={t`预期控件 AXRole（可选）`}>
              <Input
                aria-label={t`预期控件 AXRole（可选）`}
                maxLength={100}
                value={hitRole}
                onChange={(event) => {
                  setHitRole(event.target.value);
                }}
              />
            </Form.Item>
            <Form.Item label={t`单个动作（JSON）`}>
              <Input.TextArea
                aria-label={t`单个动作（JSON）`}
                rows={5}
                value={action}
                onChange={(event) => {
                  setAction(event.target.value);
                }}
              />
            </Form.Item>
            <Typography.Paragraph type="secondary">{t`可用动作：${info.data.actions.join(", ")}。像素必须选显示器；拖动 points 的 t 从 0 严格递增。键入与滚动仍须在目标应用核验。`}</Typography.Paragraph>
            <Typography.Paragraph copyable>{id}</Typography.Paragraph>
            {error && <Alert type="error" title={error} />}
            <Space wrap>
              <Button
                aria-label={t`仅预检输入`}
                disabled={!target || !canSubmit || stopped || pending}
                loading={pending}
                onClick={() => {
                  send("preflight");
                }}
              >{t`仅预检输入`}</Button>
              <Button
                aria-label={t`显式激活窗口`}
                disabled={
                  !target || !canSubmit || !control || stopped || pending
                }
                loading={pending}
                onClick={() => {
                  send("execute", true);
                }}
              >{t`显式激活窗口`}</Button>
              <Button
                type="primary"
                aria-label={t`执行单个输入`}
                disabled={
                  !target || !canSubmit || !control || stopped || pending
                }
                loading={pending}
                onClick={() => {
                  send("execute");
                }}
              >{t`执行单个输入`}</Button>
              <Button
                onClick={() => {
                  setId(crypto.randomUUID());
                  setError("");
                }}
              >{t`新建输入请求`}</Button>
            </Space>
          </Form>
        </>
      )}
      <Typography.Paragraph type="secondary">{t`停止后恢复只允许新请求，不重放旧任务。修改目标或动作后请新建请求；同 ID 变参会冲突。`}</Typography.Paragraph>
    </Section>
  );
}

function TaskForm({
  host,
  state,
  disabled,
  pending,
  onSubmit,
}: {
  host: string;
  state: DesktopData | null;
  disabled: boolean;
  pending: boolean;
  onSubmit: (request: JobRequest) => void;
}) {
  const { t } = useLingui();
  const [id, setId] = useState(() => crypto.randomUUID()),
    [operation, setOperation] = useState<"chat" | "script">("chat");
  const [app, setApp] = useState<"codex" | "zcode">("codex"),
    [mode, setMode] = useState("read");
  const [target, setTarget] = useState(""),
    [text, setText] = useState(""),
    [path, setPath] = useState(""),
    [args, setArgs] = useState("[]");
  const [error, setError] = useState("");
  const send = () => {
    try {
      const request = JobRequestSchema.parse(
        operation === "chat"
          ? {
              request_id: id,
              operation,
              app,
              mode,
              ...(mode === "recover"
                ? { original_request_id: target }
                : mode === "new"
                  ? {}
                  : { target }),
              ...(["send", "new"].includes(mode) ? { message: text } : {}),
            }
          : {
              request_id: id,
              operation,
              mode: mode === "run" ? "run" : "exec",
              path,
              arguments: JSON.parse(args) as unknown,
            },
      );
      setError("");
      onSubmit(request);
    } catch {
      setError(t`请检查目标、消息、脚本路径和参数格式。`);
    }
  };
  return (
    <Form layout="vertical" onFinish={send} disabled={disabled}>
      <Form.Item label={t`操作类型`}>
        <Select
          value={operation}
          aria-label={t`操作类型`}
          options={[
            { value: "chat", label: t`聊天应用` },
            {
              value: "script",
              label: t`脚本执行`,
              disabled: !state?.scripts_allowed,
            },
          ]}
          onChange={(value: "chat" | "script") => {
            setOperation(value);
            setMode(value === "chat" ? "read" : "exec");
          }}
        />
      </Form.Item>
      {operation === "chat" ? (
        <>
          <Form.Item label={t`应用`}>
            <Select
              value={app}
              aria-label={t`应用`}
              options={[
                { value: "codex", label: "Codex" },
                { value: "zcode", label: "ZCode" },
              ]}
              onChange={(value: "codex" | "zcode") => {
                setApp(value);
                setMode("read");
              }}
            />
          </Form.Item>
          <Form.Item label={t`聊天操作`}>
            <Select
              value={mode}
              aria-label={t`聊天操作`}
              onChange={setMode}
              options={[
                { value: "read", label: t`读取最近回复` },
                { value: "send", label: t`发送消息` },
                { value: "new", label: t`新建对话`, disabled: app !== "zcode" },
                { value: "probe", label: t`定位对话` },
                { value: "recover", label: t`恢复原请求` },
              ]}
            />
          </Form.Item>
          {mode !== "new" && (
            <Form.Item label={mode === "recover" ? t`原请求 ID` : t`对话 ID`}>
              <Input
                value={target}
                aria-label={mode === "recover" ? t`原请求 ID` : t`对话 ID`}
                onChange={(event) => {
                  setTarget(event.target.value);
                }}
              />
            </Form.Item>
          )}
          {["send", "new"].includes(mode) && (
            <Form.Item label={t`消息`}>
              <Input.TextArea
                rows={5}
                maxLength={64000}
                value={text}
                aria-label={t`消息`}
                onChange={(event) => {
                  setText(event.target.value);
                }}
              />
            </Form.Item>
          )}
        </>
      ) : (
        <>
          <Form.Item label={t`执行方式`}>
            <Select
              value={mode}
              aria-label={t`执行方式`}
              onChange={setMode}
              options={[
                { value: "exec", label: t`程序或脚本` },
                { value: "run", label: "AppleScript" },
              ]}
            />
          </Form.Item>
          <Form.Item label={t`节点上的绝对路径`}>
            <Input
              value={path}
              aria-label={t`节点上的绝对路径`}
              onChange={(event) => {
                setPath(event.target.value);
              }}
            />
          </Form.Item>
          <Form.Item label={t`参数（JSON 字符串数组）`}>
            <Input.TextArea
              rows={3}
              value={args}
              aria-label={t`参数（JSON 字符串数组）`}
              onChange={(event) => {
                setArgs(event.target.value);
              }}
            />
          </Form.Item>
        </>
      )}
      <Typography.Paragraph type="secondary">{t`执行节点：${host}。相同请求 ID 会复用原结果；要执行新任务，请先新建请求。`}</Typography.Paragraph>
      <Typography.Paragraph copyable>{id}</Typography.Paragraph>
      {error && <Alert type="error" title={error} />}
      <Space wrap>
        <Button
          type="primary"
          htmlType="submit"
          loading={pending}
          aria-label={t`提交任务`}
        >{t`提交任务`}</Button>
        <Button
          onClick={() => {
            setId(crypto.randomUUID());
            setError("");
          }}
        >{t`新建请求`}</Button>
      </Space>
    </Form>
  );
}

export function NodePanel({ host }: WorkspaceProps & { host: Host }) {
  const { t } = useLingui(),
    data = desktopData(host);
  return (
    <Section title={t`桌面自动化`}>
      <Flex gap="small" justify="space-between" wrap>
        <span>
          {data?.toolkit?.paused
            ? t`已暂停接单`
            : data?.toolkit?.desktop_busy
              ? t`任务正在使用桌面`
              : data?.availability === "ready"
                ? t`工具包已安装`
                : t`工具包未就绪`}
        </span>
        <Link
          to={`/automation?host=${encodeURIComponent(host.name)}`}
        >{t`管理桌面任务`}</Link>
      </Flex>
    </Section>
  );
}
