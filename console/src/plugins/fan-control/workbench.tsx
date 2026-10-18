import { msg } from "@lingui/core/macro";
import type { Translate } from "../../messages.ts";
import { useLingui } from "@lingui/react";
import { useLingui as useLinguiMacro } from "@lingui/react/macro";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Collapse,
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
  Upload,
} from "antd";
import { Download, Fan, Plus, Trash2 } from "lucide-react";
import type { Fleet, Host } from "../../contracts.ts";
import { displayName, nodeIdentityLabel, stale } from "../../domain.ts";
import { remoteText } from "../../messages.ts";
import { api, message } from "../../web/api.ts";
import { refreshFleet } from "../../web/useFleet.ts";
import { PageTitle, Section } from "../../web/ui.tsx";
import { TimeChart } from "../../web/chart.tsx";
import {
  activeJob,
  controllable,
  fanData,
  readyState,
  withProtectionTemperature,
} from "./domain.ts";
import {
  errorText,
  PolicySchema,
  type FanState,
  type Policy,
  type FanCommand,
  type FanJob,
} from "./contracts.ts";
import { Curve } from "./curve.tsx";
function download(name: string, content: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([content], { type })),
    anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}
function loadDraft(host: string): { revision: string; policy: Policy } | null {
  try {
    const raw: unknown = JSON.parse(
      localStorage.getItem(`mini-archipel.fan.${host}`) ?? "null",
    );
    if (
      raw &&
      typeof raw === "object" &&
      "revision" in raw &&
      typeof raw.revision === "string" &&
      "policy" in raw
    ) {
      const policy = PolicySchema.safeParse(raw.policy);
      if (policy.success)
        return { revision: raw.revision, policy: policy.data };
    }
  } catch {
    /* Recovery controls must remain available with corrupt browser storage. */
  }
  return null;
}
function jobName(job: FanJob, translate: Translate) {
  return translate(
    {
      queued: msg`排队中`,
      running: msg`运行中`,
      cancelling: msg`取消中`,
      restoring: msg`恢复温控中`,
      completed: msg`已完成`,
      cancelled: msg`已取消`,
      failed: msg`失败`,
      interrupted: msg`已中断并恢复`,
    }[job.status],
  );
}
function operationLabel(action: string, translate: Translate) {
  const labels: Record<string, ReturnType<typeof msg>> = {
    system: msg`系统自动`,
    curve: msg`曲线控制`,
    apply: msg`应用风扇曲线`,
    rollback: msg`回退曲线版本`,
    service: msg`限时控制与服务`,
    manual: msg`限时固定转速`,
    selftest: msg`风扇自检`,
    calibrate: msg`实测校准`,
    "calibrate-dry": msg`校准试运行`,
    simulate: msg`只读模拟`,
    dump: msg`读取键列表`,
    keyinfo: msg`读取键详情`,
    trywrite: msg`执行写入诊断`,
  };
  const label = labels[action];
  return label ? translate(label) : action;
}
export function FanControl({ fleet, now }: { fleet: Fleet; now: number }) {
  const { t } = useLinguiMacro(),
    { _ } = useLingui(),
    [search, setSearch] = useSearchParams();
  const host =
    fleet.hosts.find((h) => h.name === search.get("host")) ?? fleet.hosts[0];
  return (
    <>
      <PageTitle
        title={t`风扇控制`}
        description={t`查看每台节点的温控状态，编辑曲线并运行本地诊断。`}
      />
      <div className="fan-nodes">
        {fleet.hosts.map((h) => {
          const r = readyState(h)?.telemetry?.reading;
          return (
            <Button
              key={h.name}
              className={`fan-node ${host?.name === h.name ? "selected" : ""}`}
              onClick={() => {
                setSearch({ host: h.name });
              }}
            >
              <Fan size={22} />
              <span>
                <strong>{displayName(h)}</strong>
                <small>{nodeIdentityLabel(h, _)}</small>
              </span>
              <span className="fan-node-value">
                {r?.have_temp ? `${r.peak.toFixed(1)} °C` : "—"}
                <small>
                  {r
                    ? `${String(Math.round(r.rpm))} RPM`
                    : h.kind === "virtual"
                      ? t`虚拟机`
                      : t`等待连接`}
                </small>
              </span>
            </Button>
          );
        })}
      </div>
      {host ? <Workbench key={host.name} host={host} now={now} /> : <Empty />}
    </>
  );
}
export function NodePanel({
  host,
  now,
}: {
  host: Host;
  fleet: Fleet;
  now: number;
}) {
  const { t } = useLinguiMacro(),
    [search] = useSearchParams(),
    state = readyState(host),
    r = state?.telemetry?.reading;
  if (search.get("view") === "fan-control")
    return <Workbench key={host.name} host={host} now={now} />;
  return (
    <Section
      title={t`风扇控制`}
      action={<Link to="?view=fan-control">{t`编辑曲线`}</Link>}
    >
      {host.kind === "virtual" ? (
        <Typography.Text type="secondary">{t`虚拟机无硬件风扇`}</Typography.Text>
      ) : (
        <Space wrap>
          <span>
            {t`实际转速`}{" "}
            <b className="mono">{r ? Math.round(r.rpm) : "—"} RPM</b>
          </span>
          <span>
            {t`最高温度`}{" "}
            <b className="mono">{r?.have_temp ? r.peak.toFixed(1) : "—"} °C</b>
          </span>
          <Typography.Text type="secondary">
            {state
              ? state.telemetry?.paused
                ? t`系统自动`
                : t`曲线控制`
              : t`控制端尚未就绪`}
          </Typography.Text>
        </Space>
      )}
    </Section>
  );
}
function Workbench({ host, now }: { host: Host; now: number }) {
  const { t } = useLinguiMacro(),
    data = fanData(host);
  if (host.kind === "virtual" || data?.availability === "unsupported")
    return (
      <Section title={t`风扇控制`}>
        <Empty description={t`虚拟机无硬件风扇`} />
      </Section>
    );
  if (data?.availability !== "ready")
    return (
      <Section title={t`风扇控制`}>
        <Alert
          showIcon
          type="info"
          title={t`控制端尚未就绪`}
          description={t`在节点安装风扇控制插件后，即可读取曲线和管理温控。基础监测仍可使用。`}
        />
      </Section>
    );
  return <Editor key={host.name} host={host} state={data} now={now} />;
}
function Editor({
  host,
  state,
  now,
}: {
  host: Host;
  state: FanState;
  now: number;
}) {
  const { t } = useLinguiMacro(),
    { _ } = useLingui(),
    { message: feedback, modal } = App.useApp(),
    client = useQueryClient();
  const [saved, setSaved] = useState(() => loadDraft(host.name)),
    [storageError, setStorageError] = useState(false);
  const dirty =
      saved?.policy !== undefined &&
      JSON.stringify(saved.policy) !== JSON.stringify(state.policy),
    policy = dirty ? saved.policy : state.policy,
    base = dirty ? saved.revision : state.revision,
    conflict = dirty && base !== state.revision;
  const job = activeJob(state),
    allowed = controllable(host, state, now),
    reading = state.telemetry?.reading,
    runtime = state.telemetry?.runtime,
    valid = PolicySchema.safeParse(policy).success;
  const change = (next: Policy) => {
    const draft = { revision: base, policy: next };
    setSaved(draft);
    try {
      localStorage.setItem(
        `mini-archipel.fan.${host.name}`,
        JSON.stringify(draft),
      );
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  };
  const patch = (fields: Partial<Policy>) => {
    change({ ...policy, ...fields });
  };
  const discard = () => {
    setSaved(null);
    try {
      localStorage.removeItem(`mini-archipel.fan.${host.name}`);
    } catch {
      setStorageError(true);
    }
  };
  const mutation = useMutation({
    mutationFn: (command: FanCommand | { cancel: string; system: boolean }) =>
      "cancel" in command
        ? api.pluginAction("fan-control", "cancel", {
            host: host.name,
            job_id: command.cancel,
            system: command.system,
          })
        : api.pluginAction("fan-control", "command", {
            host: host.name,
            request_id: crypto.randomUUID(),
            expected_revision: base,
            command,
          }),
    onSuccess: async () => {
      await refreshFleet(client);
      void feedback.success(t`任务已提交，进度由节点持续记录。`);
    },
    onError: (error: unknown) => {
      void feedback.error(message(error, _));
    },
  });
  const submit = (
    command: FanCommand,
    title: string,
    detail = t`操作由节点本地执行。关闭页面不会中断任务，可在任务记录中取消。`,
  ) => {
    modal.confirm({
      title: `${displayName(host)} · ${title}`,
      content: detail,
      okText: t`确认`,
      cancelText: t`取消`,
      onOk: () => mutation.mutateAsync(command),
    });
  };
  const blocked = !allowed || Boolean(job) || mutation.isPending;
  const recoveryBlocked =
    !state.control_allowed ||
    stale(host, now) ||
    Boolean(job) ||
    mutation.isPending;
  const [manualRpm, setManualRpm] = useState(state.policy.min_rpm),
    [seconds, setSeconds] = useState(30),
    [cap, setCap] = useState(65),
    [prefix, setPrefix] = useState("Tp"),
    [smcKeys, setSmcKeys] = useState("F0Ac,F0Tg,F0md"),
    [writeKey, setWriteKey] = useState(state.capabilities.write_keys[0] ?? ""),
    [writeValue, setWriteValue] = useState(0),
    [expectedValue, setExpectedValue] = useState(0);
  const updateLimit = (key: "min_rpm" | "max_rpm", value: number | null) => {
    if (value === null) return;
    const min = key === "min_rpm" ? value : policy.min_rpm,
      max = key === "max_rpm" ? value : policy.max_rpm;
    patch({
      [key]: value,
      curve: policy.curve.map((p, i) => ({
        ...p,
        rpm:
          i === 0
            ? min
            : i === policy.curve.length - 1
              ? max
              : Math.max(min, Math.min(max, p.rpm)),
      })),
    });
  };
  const numeric = (
    key: keyof Pick<
      Policy,
      | "poll_interval"
      | "alpha_up"
      | "alpha_down"
      | "hysteresis"
      | "down_delay"
      | "slew_up"
      | "slew_down"
    >,
    label: string,
    min: number,
    max: number,
    step = 1,
  ) => (
    <Form.Item label={label} key={key}>
      <InputNumber
        aria-label={label}
        value={policy[key]}
        min={min}
        max={max}
        step={step}
        onChange={(v) => {
          if (v !== null) patch({ [key]: v });
        }}
      />
    </Form.Item>
  );
  const sensors = Array.from(
      new Set([
        ...policy.sensors,
        ...(state.telemetry?.sensors.map((s) => s.key) ?? []),
      ]),
    ).map((key) => ({
      key,
      temp: state.telemetry?.sensors.find((s) => s.key === key)?.temp ?? null,
      selected: policy.sensors.includes(key),
    })),
    last = state.jobs.at(-1);
  return (
    <div className="fan-workbench">
      {!allowed ? (
        <Alert
          showIcon
          type="warning"
          title={
            !state.control_allowed
              ? t`此节点仅允许查看风扇，尚未授权控制。`
              : t`数据过期或节点不可用，控制操作暂不可用。`
          }
        />
      ) : null}
      {state.telemetry_error ? (
        <Alert
          showIcon
          type="error"
          title={t`温控读取失败`}
          description={t`保留最后一次读数。恢复控制仍可从节点本地执行。`}
        />
      ) : null}
      <Section
        title={t`实时温控`}
        action={
          <Space>
            <Button
              disabled={recoveryBlocked}
              onClick={() => {
                submit({ action: "system", data: {} }, t`交还系统自动控制`);
              }}
            >{t`系统自动`}</Button>
            <Button
              disabled={recoveryBlocked}
              onClick={() => {
                submit({ action: "curve", data: {} }, t`启用节点曲线`);
              }}
            >{t`曲线控制`}</Button>
          </Space>
        }
      >
        <div className="fan-readings">
          <div>
            <small>{t`最高温度`}</small>
            <strong>
              {reading?.have_temp ? reading.peak.toFixed(1) : "—"} <em>°C</em>
            </strong>
            <small>{reading?.peak_sensor ?? "—"}</small>
          </div>
          <div>
            <small>{t`实际转速`}</small>
            <strong>
              {reading ? Math.round(reading.rpm) : "—"} <em>RPM</em>
            </strong>
            <small>{reading?.forced ? t`手动接管` : t`系统自动`}</small>
          </div>
          <div>
            <small>{t`目标转速`}</small>
            <strong>
              {runtime ? Math.round(runtime.command_rpm) : "—"} <em>RPM</em>
            </strong>
            <small>
              {runtime?.emergency
                ? t`温度保护已触发`
                : state.telemetry?.paused
                  ? t`曲线已暂停`
                  : runtime
                    ? t`曲线控制`
                    : t`温控服务未运行`}
            </small>
          </div>
          <div>
            <small>{t`控制温度`}</small>
            <strong>
              {runtime?.control_temp?.toFixed(1) ?? "—"} <em>°C</em>
            </strong>
            <small>{t`平滑后用于曲线决策`}</small>
          </div>
        </div>
        <Descriptions
          size="small"
          className="fan-details"
          items={[
            {
              key: "sensors",
              label: t`温度传感器`,
              children: `${String(sensors.filter((s) => s.temp !== null).length)} / ${String(policy.sensors.length)}`,
            },
            {
              key: "fans",
              label: t`风扇`,
              children:
                reading?.fans
                  .map(
                    (f) =>
                      `#${String(f.idx)} · ${String(Math.round(f.rpm))} / ${String(Math.round(f.target))} RPM`,
                  )
                  .join(" · ") ?? "—",
            },
            {
              key: "dwell",
              label: t`降档等待`,
              children: runtime
                ? runtime.down_remaining
                    .map((v) => `${String(Math.ceil(v))} s`)
                    .join(" / ")
                : "—",
            },
          ]}
        />
      </Section>
      {job ? (
        <Alert
          showIcon
          type="info"
          title={`${jobName(job, _)} · ${operationLabel(job.action, _)}`}
          description={
            <Flex gap="small" wrap align="center">
              <span>
                {job.total
                  ? `${String(job.progress)} / ${String(job.total)}`
                  : job.expires_at
                    ? t`剩余 ${String(Math.max(0, Math.ceil((job.expires_at - now) / 1000)))} 秒`
                    : t`节点正在执行，刷新页面可继续查看。`}
              </span>
              <Button
                loading={
                  job.status === "cancelling" || job.status === "restoring"
                }
                onClick={() => {
                  mutation.mutate({ cancel: job.id, system: false });
                }}
              >{t`取消任务`}</Button>
              <Button
                onClick={() => {
                  mutation.mutate({ cancel: job.id, system: true });
                }}
              >{t`取消并交还系统`}</Button>
            </Flex>
          }
        />
      ) : null}
      {last?.error ? (
        <Alert
          showIcon
          type={last.restored === false ? "error" : "warning"}
          title={remoteText(errorText(last.error), _)}
        />
      ) : null}
      <Section
        title={t`风扇曲线`}
        subtitle={t`基础档交还系统；温度跨过阈值立即升档，降档遵循滞回和等待时间。`}
        action={
          <Tag color={conflict ? "warning" : dirty ? "processing" : "default"}>
            {conflict ? t`版本冲突` : dirty ? t`未应用的草稿` : t`与节点一致`}
          </Tag>
        }
      >
        {conflict ? (
          <Alert
            type="warning"
            showIcon
            title={t`节点曲线已变化，草稿已保留。请比较后重新载入或导出草稿。`}
          />
        ) : null}
        {storageError ? (
          <Alert type="warning" title={t`浏览器无法保存草稿，请先导出文件。`} />
        ) : null}
        {!valid ? (
          <Alert
            type="error"
            title={t`温度必须递增、转速不能递减，保护档须使用最高转速，其他阈值不得超过保护温度。`}
          />
        ) : null}
        <div className="fan-editor-grid">
          <Curve
            policy={policy}
            applied={state.policy}
            runtime={state.telemetry}
            onChange={change}
          />
          <div className="fan-points">
            <div className="fan-point-heading">
              <span>{t`温度阈值`}</span>
              <span>{t`目标转速`}</span>
            </div>
            {policy.curve.map((p, i) => (
              <div className="fan-point" key={i}>
                {i === policy.curve.length - 1 ? (
                  <span className="fan-protection-note">{t`保护档：达到此温度，立即使用最高转速（100%）。`}</span>
                ) : null}
                <InputNumber
                  aria-label={
                    i === policy.curve.length - 1
                      ? t`保护温度`
                      : t`第 ${String(i + 1)} 档温度`
                  }
                  value={i === 0 ? 20 : p.t}
                  min={
                    i === policy.curve.length - 1
                      ? Math.max(40, (policy.curve.at(-2)?.t ?? 0) + 1)
                      : 20
                  }
                  max={
                    i === policy.curve.length - 1 ? 100 : policy.critical_temp
                  }
                  disabled={i === 0}
                  suffix="°C"
                  onChange={(v) => {
                    if (v === null) return;
                    if (i === policy.curve.length - 1)
                      change(withProtectionTemperature(policy, v));
                    else
                      patch({
                        curve: policy.curve.map((p, j) =>
                          i === j ? { ...p, t: v } : p,
                        ),
                      });
                  }}
                />
                {i === 0 ? (
                  <Input
                    aria-label={t`第 ${String(i + 1)} 档转速`}
                    value={t`系统默认`}
                    readOnly
                  />
                ) : (
                  <InputNumber
                    aria-label={t`第 ${String(i + 1)} 档转速`}
                    value={p.rpm}
                    min={policy.min_rpm}
                    max={policy.max_rpm}
                    step={50}
                    disabled={i === policy.curve.length - 1}
                    suffix={
                      i === policy.curve.length - 1 ? "RPM · 100%" : "RPM"
                    }
                    onChange={(v) => {
                      if (v !== null)
                        patch({
                          curve: policy.curve.map((p, j) =>
                            i === j ? { ...p, rpm: v } : p,
                          ),
                        });
                    }}
                  />
                )}
                <Button
                  type="text"
                  icon={<Trash2 size={15} />}
                  aria-label={t`删除第 ${String(i + 1)} 档`}
                  disabled={i === 0 || i === policy.curve.length - 1}
                  onClick={() => {
                    patch({ curve: policy.curve.filter((_p, j) => j !== i) });
                  }}
                />
              </div>
            ))}
            <Button
              icon={<Plus size={15} />}
              disabled={
                policy.curve.length >= 16 ||
                !policy.curve.some(
                  (p, i) => i > 0 && p.t - (policy.curve[i - 1]?.t ?? 0) >= 2,
                )
              }
              onClick={() => {
                const at = policy.curve.findIndex(
                    (p, i) => i > 0 && p.t - (policy.curve[i - 1]?.t ?? 0) >= 2,
                  ),
                  previous = policy.curve[at - 1],
                  next = policy.curve[at];
                if (previous && next)
                  patch({
                    curve: [
                      ...policy.curve.slice(0, at),
                      {
                        t: Math.floor((previous.t + next.t) / 2),
                        rpm: Math.round((previous.rpm + next.rpm) / 100) * 50,
                      },
                      ...policy.curve.slice(at),
                    ],
                  });
              }}
            >{t`增加档位`}</Button>
          </div>
        </div>
        <Form layout="vertical" className="fan-parameters fan-limits">
          <Form.Item label={t`最低转速`}>
            <InputNumber
              aria-label={t`最低转速`}
              min={1000}
              max={policy.max_rpm}
              value={policy.min_rpm}
              suffix="RPM"
              onChange={(v) => {
                updateLimit("min_rpm", v);
              }}
            />
          </Form.Item>
          <Form.Item label={t`最高转速`}>
            <InputNumber
              aria-label={t`最高转速`}
              min={policy.min_rpm}
              max={reading?.max_rpm ?? 20000}
              value={policy.max_rpm}
              suffix="RPM"
              onChange={(v) => {
                updateLimit("max_rpm", v);
              }}
            />
          </Form.Item>
          {numeric("hysteresis", t`降档滞回（°C）`, 0, 15)}
          {numeric("down_delay", t`降档等待（秒）`, 0, 300)}
        </Form>
        <Collapse
          ghost
          items={[
            {
              key: "response",
              label: t`响应参数与传感器`,
              children: (
                <>
                  <Alert
                    type="info"
                    showIcon
                    title={t`当前适配器支持显式传感器和 force 模式，升档不延迟；不支持 floor 模式或自动枚举。`}
                  />
                  <Form layout="vertical" className="fan-parameters">
                    {numeric("poll_interval", t`采样周期（秒）`, 0.5, 10, 0.5)}
                    {numeric("alpha_up", t`升温平滑系数`, 0.01, 1, 0.01)}
                    {numeric("alpha_down", t`降温平滑系数`, 0.01, 1, 0.01)}
                    {numeric(
                      "slew_up",
                      t`升速限制（RPM/秒，0 为不限）`,
                      0,
                      20000,
                    )}
                    {numeric(
                      "slew_down",
                      t`降速限制（RPM/秒，0 为不限）`,
                      0,
                      20000,
                    )}
                    <Form.Item label={t`传感器聚合`}>
                      <Select
                        aria-label={t`传感器聚合`}
                        value={policy.aggregate}
                        options={[
                          { value: "max", label: t`最高温度` },
                          { value: "mean", label: t`平均温度` },
                        ]}
                        onChange={(v) => {
                          patch({ aggregate: v });
                        }}
                      />
                    </Form.Item>
                    <Form.Item label={t`受控风扇`}>
                      <Select
                        mode="multiple"
                        aria-label={t`受控风扇`}
                        value={policy.fans}
                        options={
                          reading?.fans.map((f) => ({
                            value: f.idx,
                            label: `#${String(f.idx)}`,
                          })) ?? []
                        }
                        onChange={(v) => {
                          patch({ fans: v });
                        }}
                      />
                    </Form.Item>
                  </Form>
                  <Form.Item label={t`曲线传感器`}>
                    <Select
                      mode="multiple"
                      aria-label={t`曲线传感器`}
                      value={policy.sensors}
                      options={sensors.map((s) => ({
                        value: s.key,
                        label: `${s.key} · ${s.temp?.toFixed(1) ?? "—"} °C`,
                      }))}
                      onChange={(v) => {
                        patch({ sensors: v });
                      }}
                    />
                  </Form.Item>
                </>
              ),
            },
          ]}
        />
        <Flex justify="space-between" gap="small" wrap className="fan-toolbar">
          <Space wrap>
            <Upload
              accept="application/json,.json"
              showUploadList={false}
              beforeUpload={async (file) => {
                try {
                  const parsed: unknown = JSON.parse(await file.text());
                  change(PolicySchema.parse(parsed));
                } catch {
                  void feedback.error(t`导入文件不是有效的风扇策略。`);
                }
                return false;
              }}
            >
              <Button>{t`导入草稿`}</Button>
            </Upload>
            <Button
              icon={<Download size={15} />}
              onClick={() => {
                download(
                  `${host.name}-fan-policy.json`,
                  JSON.stringify(policy, null, 2),
                );
              }}
            >{t`导出草稿`}</Button>
          </Space>
          <Space>
            <Button
              disabled={!dirty}
              onClick={discard}
            >{t`重新载入节点曲线`}</Button>
            <Button
              type="primary"
              disabled={blocked || !dirty || conflict || !valid}
              onClick={() => {
                submit(
                  { action: "apply", data: { policy } },
                  t`应用风扇曲线`,
                  t`新版本确认载入后才视为生效。若校验或载入失败，节点会恢复原配置。`,
                );
              }}
            >{t`应用到节点`}</Button>
          </Space>
        </Flex>
      </Section>
      <div className="fan-history-grid">
        <Section title={t`温度走势`}>
          <TimeChart
            label={t`风扇温度`}
            unit="°C"
            max={100}
            series={[
              {
                name: t`最高温度`,
                color: "#c28942",
                points: state.samples.flatMap((s) =>
                  s.peak === null ? [] : [{ ts: s.ts, value: s.peak }],
                ),
              },
              {
                name: t`控制温度`,
                color: "#078990",
                points: state.samples.flatMap((s) =>
                  s.temp === null ? [] : [{ ts: s.ts, value: s.temp }],
                ),
              },
            ]}
          />
        </Section>
        <Section title={t`风扇走势`}>
          <TimeChart
            label={t`风扇转速`}
            unit="RPM"
            max={policy.max_rpm}
            series={[
              {
                name: t`实际转速`,
                color: "#078990",
                points: state.samples.flatMap((s) =>
                  s.rpm === null ? [] : [{ ts: s.ts, value: s.rpm }],
                ),
              },
              {
                name: t`目标转速`,
                color: "#8d72bb",
                points: state.samples.flatMap((s) =>
                  s.target === null ? [] : [{ ts: s.ts, value: s.target }],
                ),
              },
            ]}
          />
        </Section>
      </div>
      <Collapse
        items={[
          {
            key: "manual",
            label: t`限时控制与服务`,
            children: (
              <>
                <Alert
                  type="info"
                  showIcon
                  title={t`限时控制到期、取消、传感器异常或触发温度保护时，节点会恢复之前的温控模式。`}
                />
                <Form layout="inline" className="fan-inline-form">
                  <Form.Item label={t`固定转速`}>
                    <InputNumber
                      aria-label={t`固定转速`}
                      min={policy.min_rpm}
                      max={policy.max_rpm}
                      value={manualRpm}
                      suffix="RPM"
                      onChange={(v) => {
                        if (v !== null) setManualRpm(v);
                      }}
                    />
                  </Form.Item>
                  <Form.Item label={t`持续秒数`}>
                    <InputNumber
                      aria-label={t`持续秒数`}
                      min={5}
                      max={900}
                      value={seconds}
                      onChange={(v) => {
                        if (v !== null) setSeconds(v);
                      }}
                    />
                  </Form.Item>
                  <Button
                    disabled={blocked}
                    onClick={() => {
                      submit(
                        {
                          action: "manual",
                          data: { rpm: manualRpm, seconds, method: "force" },
                        },
                        t`限时固定转速`,
                      );
                    }}
                  >{t`开始限时控制`}</Button>
                </Form>
                <Space wrap>
                  {(["start", "stop", "reload"] as const).map((operation) => (
                    <Button
                      key={operation}
                      disabled={blocked}
                      onClick={() => {
                        submit(
                          { action: "service", data: { operation } },
                          operation === "start"
                            ? t`启动温控服务`
                            : operation === "stop"
                              ? t`停止服务并交还系统`
                              : t`重新载入温控服务`,
                        );
                      }}
                    >
                      {operation === "start"
                        ? t`启动服务`
                        : operation === "stop"
                          ? t`停止服务`
                          : t`重新载入服务`}
                    </Button>
                  ))}
                </Space>
              </>
            ),
          },
          {
            key: "diagnostics",
            label: t`校准、自检与 SMC 诊断`,
            children: (
              <>
                <Alert
                  showIcon
                  type="warning"
                  title={t`校准和校准试运行都会产生全核心 CPU 负载。试运行不写风扇，也不会生成实测曲线建议。`}
                />
                <Space wrap className="fan-toolbar">
                  <InputNumber
                    aria-label={t`校准温度上限`}
                    value={cap}
                    min={40}
                    max={Math.min(95, policy.critical_temp - 5)}
                    suffix="°C"
                    onChange={(v) => {
                      if (v !== null) setCap(v);
                    }}
                  />
                  <Button
                    disabled={blocked}
                    onClick={() => {
                      submit(
                        { action: "calibrate", data: { cap } },
                        t`开始实测校准`,
                        t`此操作将产生全核心 CPU 负载并逐档调整风扇，约需数分钟。可随时取消；建议曲线只会导入草稿，不会自动应用。`,
                      );
                    }}
                  >{t`实测校准`}</Button>
                  <Button
                    disabled={blocked}
                    onClick={() => {
                      submit(
                        { action: "calibrate-dry", data: { cap } },
                        t`开始校准试运行`,
                        t`会产生全核心 CPU 负载，但不写风扇。可随时取消。`,
                      );
                    }}
                  >{t`校准试运行`}</Button>
                  <Button
                    disabled={blocked}
                    onClick={() => {
                      submit(
                        { action: "selftest", data: {} },
                        t`运行风扇自检`,
                        t`自检会逐档改变风扇转速并核对实际读数，完成或取消后恢复温控。`,
                      );
                    }}
                  >{t`风扇自检`}</Button>
                  <Button
                    disabled={blocked}
                    onClick={() => {
                      submit(
                        { action: "simulate", data: { seconds: 15 } },
                        t`模拟温控 15 秒`,
                      );
                    }}
                  >{t`只读模拟`}</Button>
                </Space>
                <Form layout="inline" className="fan-inline-form">
                  <Form.Item label={t`SMC 前缀`}>
                    <Input
                      aria-label={t`SMC 前缀`}
                      value={prefix}
                      maxLength={2}
                      onChange={(e) => {
                        setPrefix(e.target.value);
                      }}
                    />
                  </Form.Item>
                  <Button
                    disabled={blocked || !/^[A-Za-z0-9]{2}$/.test(prefix)}
                    onClick={() => {
                      submit(
                        { action: "dump", data: { prefix } },
                        t`读取 SMC 键`,
                      );
                    }}
                  >{t`读取键列表`}</Button>
                  <Form.Item label={t`SMC 键`}>
                    <Input
                      aria-label={t`SMC 键`}
                      value={smcKeys}
                      onChange={(e) => {
                        setSmcKeys(e.target.value);
                      }}
                    />
                  </Form.Item>
                  <Button
                    disabled={
                      blocked ||
                      !smcKeys
                        .split(",")
                        .every((k) => /^[A-Za-z0-9#]{4}$/.test(k))
                    }
                    onClick={() => {
                      submit(
                        {
                          action: "keyinfo",
                          data: { keys: smcKeys.split(",") },
                        },
                        t`读取 SMC 键详情`,
                      );
                    }}
                  >{t`读取键详情`}</Button>
                </Form>
                <Collapse
                  ghost
                  items={[
                    {
                      key: "write",
                      label: t`管理员授权的写入诊断`,
                      children: (
                        <>
                          <Typography.Paragraph type="secondary">{t`仅允许节点管理员列出的风扇键；写入前会核对当前值，任务结束后恢复温控。`}</Typography.Paragraph>
                          <Form layout="inline" className="fan-inline-form">
                            <Form.Item label={t`授权键`}>
                              <Select
                                aria-label={t`授权键`}
                                value={writeKey}
                                options={state.capabilities.write_keys.map(
                                  (value) => ({ value, label: value }),
                                )}
                                onChange={setWriteKey}
                              />
                            </Form.Item>
                            <Form.Item label={t`预期当前值`}>
                              <InputNumber
                                aria-label={t`预期当前值`}
                                value={expectedValue}
                                onChange={(v) => {
                                  if (v !== null) setExpectedValue(v);
                                }}
                              />
                            </Form.Item>
                            <Form.Item label={t`写入值`}>
                              <InputNumber
                                aria-label={t`写入值`}
                                value={writeValue}
                                onChange={(v) => {
                                  if (v !== null) setWriteValue(v);
                                }}
                              />
                            </Form.Item>
                            <Button
                              danger
                              disabled={blocked || !writeKey}
                              onClick={() => {
                                submit(
                                  {
                                    action: "trywrite",
                                    data: {
                                      key: writeKey,
                                      value: writeValue,
                                      expected_value: expectedValue,
                                    },
                                  },
                                  t`执行 SMC 写入诊断`,
                                );
                              }}
                            >{t`执行写入诊断`}</Button>
                          </Form>
                        </>
                      ),
                    },
                  ]}
                />
              </>
            ),
          },
          {
            key: "sensors",
            label: t`全部传感器与风扇`,
            children: (
              <Table
                rowKey="key"
                size="small"
                pagination={{ pageSize: 12 }}
                dataSource={sensors}
                columns={[
                  { title: t`传感器`, dataIndex: "key" },
                  {
                    title: t`温度`,
                    key: "temp",
                    defaultSortOrder: "descend",
                    sorter: (a, b) => (a.temp ?? -1) - (b.temp ?? -1),
                    render: (_v: unknown, s) =>
                      s.temp === null ? t`未读到` : `${s.temp.toFixed(1)} °C`,
                  },
                  {
                    title: t`用于曲线`,
                    key: "selected",
                    render: (_v: unknown, s) => (s.selected ? t`是` : t`否`),
                  },
                ]}
              />
            ),
          },
          {
            key: "tasks",
            label: t`任务、版本与日志`,
            children: (
              <>
                <Flex justify="end" gap="small" wrap>
                  <Button
                    onClick={() => {
                      download(
                        `${host.name}-fan-diagnostics.json`,
                        JSON.stringify(
                          {
                            jobs: state.jobs,
                            events: state.events,
                            policy: state.policy,
                            telemetry: state.telemetry,
                          },
                          null,
                          2,
                        ),
                      );
                    }}
                  >{t`导出诊断记录`}</Button>
                  <Button
                    onClick={() => {
                      download(
                        `${host.name}-fan-samples.csv`,
                        "timestamp,temperature_c,peak_c,rpm,target_rpm\n" +
                          state.samples
                            .map((s) =>
                              [s.ts, s.temp, s.peak, s.rpm, s.target].join(","),
                            )
                            .join("\n"),
                        "text/csv",
                      );
                    }}
                  >{t`导出走势 CSV`}</Button>
                </Flex>
                <Collapse
                  ghost
                  items={state.jobs.toReversed().map((j) => ({
                    key: j.id,
                    label: (
                      <Space>
                        <Tag
                          color={
                            j.status === "failed"
                              ? "error"
                              : j.status === "completed"
                                ? "success"
                                : "default"
                          }
                        >
                          {jobName(j, _)}
                        </Tag>
                        <span>{operationLabel(j.action, _)}</span>
                        <Typography.Text type="secondary">
                          {new Date(j.requested_at).toLocaleString()}
                        </Typography.Text>
                      </Space>
                    ),
                    children: (
                      <>
                        {j.error ? (
                          <Alert
                            type="warning"
                            title={remoteText(errorText(j.error), _)}
                          />
                        ) : null}
                        <pre className="fan-log">{j.log || t`无日志输出`}</pre>
                        {j.result !== null ? (
                          <pre className="fan-log">
                            {JSON.stringify(j.result, null, 2)}
                          </pre>
                        ) : null}
                        {Array.isArray(j.result)
                          ? j.result.map((r: unknown, i) => {
                              if (
                                !r ||
                                typeof r !== "object" ||
                                !("curve" in r) ||
                                !("valid" in r) ||
                                r.valid !== true ||
                                !Array.isArray(r.curve)
                              )
                                return null;
                              const parsed = PolicySchema.safeParse({
                                ...policy,
                                curve: r.curve,
                              });
                              return parsed.success ? (
                                <Button
                                  key={i}
                                  onClick={() => {
                                    change(parsed.data);
                                  }}
                                >{t`将校准建议导入草稿`}</Button>
                              ) : null;
                            })
                          : null}
                      </>
                    ),
                  }))}
                />
                <Typography.Title
                  level={5}
                >{t`可回退的曲线版本`}</Typography.Title>
                <Space wrap>
                  {state.revisions.toReversed().map((r, i) => (
                    <Button
                      key={`${r.revision}-${String(i)}`}
                      disabled={blocked || conflict}
                      onClick={() => {
                        submit(
                          {
                            action: "rollback",
                            data: { revision: r.revision },
                          },
                          t`回退曲线版本`,
                        );
                      }}
                    >
                      {new Date(r.ts).toLocaleString()} ·{" "}
                      {r.revision.slice(0, 8)}
                    </Button>
                  ))}
                </Space>
              </>
            ),
          },
        ]}
      />
    </div>
  );
}
