import { z } from "zod";
const finite = z.number();
export const PolicySchema = z
  .strictObject({
    curve: z
      .array(
        z.strictObject({
          t: finite.min(0).max(100),
          rpm: finite.min(100).max(20000),
        }),
      )
      .min(2)
      .max(16),
    mode: z.literal("force"),
    aggregate: z.enum(["max", "mean"]),
    fans: z.array(z.number().int().min(0).max(7)).min(1).max(8),
    sensors: z
      .array(z.string().regex(/^[A-Za-z0-9]{4}$/))
      .min(1)
      .max(64),
    poll_interval: finite.min(0.5).max(10),
    alpha_up: finite.min(0.01).max(1),
    alpha_down: finite.min(0.01).max(1),
    hysteresis: finite.min(0).max(15),
    down_delay: finite.min(0).max(300),
    up_delay: z.literal(0),
    slew_up: finite.min(0).max(20000),
    slew_down: finite.min(0).max(20000),
    min_rpm: finite.min(100).max(20000),
    max_rpm: finite.min(100).max(20000),
    critical_temp: finite.min(40).max(100),
  })
  .superRefine((p, ctx) => {
    const fail = (message: string) => {
      ctx.addIssue({ code: "custom", message });
    };
    if (
      new Set(p.sensors).size !== p.sensors.length ||
      new Set(p.fans).size !== p.fans.length
    )
      fail("duplicate sensor or fan");
    if (
      p.min_rpm > p.max_rpm ||
      p.curve[0]?.t !== 0 ||
      p.curve[0].rpm !== p.min_rpm ||
      p.curve.at(-1)?.rpm !== p.max_rpm
    )
      fail("invalid curve limits");
    p.curve.forEach((point, i) => {
      const previous = p.curve[i - 1];
      if (
        point.t > p.critical_temp ||
        point.rpm < p.min_rpm ||
        point.rpm > p.max_rpm ||
        (previous && (point.t <= previous.t || point.rpm < previous.rpm))
      )
        fail("curve must ascend and remain within limits");
    });
  });
export type Policy = z.infer<typeof PolicySchema>;
const ReadingSchema = z.object({
  ok: z.boolean(),
  have_temp: z.boolean(),
  temp: finite,
  peak: finite,
  peak_sensor: z.string(),
  nsensors: finite,
  rpm: finite,
  target: finite,
  min_rpm: finite,
  max_rpm: finite,
  forced: z.boolean(),
  paused: z.boolean(),
  level: finite,
  fans: z.array(
    z.object({ idx: finite, rpm: finite, target: finite, max: finite }),
  ),
  critical_temp: finite,
});
const RuntimeSchema = z.object({
  pid: finite,
  ts: finite,
  config_identity: z.string(),
  control_temp: finite.nullable(),
  raw_temp: finite,
  peak: finite,
  level: finite,
  command_rpm: finite,
  target_rpm: finite,
  emergency: z.boolean(),
  paused: z.boolean(),
  down_remaining: z.array(finite),
});
const JobSchema = z.object({
  id: z.string(),
  action: z.string(),
  status: z.enum([
    "queued",
    "running",
    "cancelling",
    "restoring",
    "completed",
    "cancelled",
    "failed",
    "interrupted",
  ]),
  requested_at: finite,
  started_at: finite.nullable(),
  finished_at: finite.nullable(),
  phase: z.string(),
  progress: finite,
  total: finite,
  log: z.string(),
  result: z.unknown().nullable(),
  error: z.string().nullable(),
  restored: z.boolean().nullable(),
  expires_at: finite.nullable(),
});
export type FanJob = z.infer<typeof JobSchema>;
const common = { control_allowed: z.boolean(), interval_ms: finite };
export const ReadySchema = z.object({
  ...common,
  availability: z.literal("ready"),
  reason: z.null(),
  revision: z.string(),
  policy: PolicySchema,
  telemetry: z
    .object({
      reading: ReadingSchema,
      sensors: z.array(z.object({ key: z.string(), temp: finite.nullable() })),
      runtime: RuntimeSchema.nullable(),
      daemon_pid: finite.nullable(),
      service_running: z.boolean(),
      paused: z.boolean(),
    })
    .nullable(),
  telemetry_error: z.string().nullable(),
  sampled_at: finite,
  samples: z.array(
    z.object({
      ts: finite,
      temp: finite.nullable(),
      peak: finite.nullable(),
      rpm: finite.nullable(),
      target: finite.nullable(),
    }),
  ),
  jobs: z.array(JobSchema),
  revisions: z.array(
    z.object({ revision: z.string(), ts: finite, policy: PolicySchema }),
  ),
  events: z.array(
    z.object({ ts: finite, kind: z.string(), job_id: z.string().nullable() }),
  ),
  capabilities: z.object({
    curve_modes: z.array(z.string()),
    rise_delay: z.boolean(),
    sensor_auto: z.boolean(),
    floor: z.boolean(),
    write_keys: z.array(z.string()),
    max_steps: finite,
    manual_max_seconds: finite,
  }),
});
export type FanState = z.infer<typeof ReadySchema>;
export const DataSchema = z.discriminatedUnion("availability", [
  ReadySchema,
  z.object({
    ...common,
    availability: z.literal("helper_missing"),
    reason: z.literal("installation_required"),
    reading: z.unknown().nullable(),
  }),
  z.object({
    ...common,
    availability: z.literal("unsupported"),
    reason: z.literal("virtual_machine"),
    reading: z.null(),
  }),
]);
const Key = z.string().regex(/^[A-Za-z0-9#]{4}$/);
export const CommandSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("apply"),
    data: z.strictObject({ policy: PolicySchema }),
  }),
  z.strictObject({
    action: z.literal("rollback"),
    data: z.strictObject({ revision: z.string().regex(/^[a-f0-9]{64}$/) }),
  }),
  z.strictObject({
    action: z.enum(["system", "curve", "selftest"]),
    data: z.strictObject({}),
  }),
  z.strictObject({
    action: z.literal("service"),
    data: z.strictObject({ operation: z.enum(["start", "stop", "reload"]) }),
  }),
  z.strictObject({
    action: z.literal("manual"),
    data: z.strictObject({
      rpm: finite.min(100).max(20000),
      seconds: finite.min(5).max(900),
      method: z.literal("force"),
    }),
  }),
  z.strictObject({
    action: z.enum(["calibrate", "calibrate-dry"]),
    data: z.strictObject({ cap: finite.min(40).max(95) }),
  }),
  z.strictObject({
    action: z.literal("simulate"),
    data: z.strictObject({ seconds: finite.min(5).max(60) }),
  }),
  z.strictObject({
    action: z.literal("dump"),
    data: z.strictObject({ prefix: z.string().regex(/^[A-Za-z0-9]{2}$/) }),
  }),
  z.strictObject({
    action: z.literal("keyinfo"),
    data: z.strictObject({ keys: z.array(Key).min(1).max(32) }),
  }),
  z.strictObject({
    action: z.literal("trywrite"),
    data: z.strictObject({
      key: Key,
      value: finite.min(0).max(20000),
      expected_value: finite.min(0).max(20000),
    }),
  }),
]);
export type FanCommand = z.infer<typeof CommandSchema>;
export const SubmitSchema = z.strictObject({
  host: z.string(),
  request_id: z.uuid(),
  expected_revision: z.string().regex(/^[a-f0-9]{64}$/),
  command: CommandSchema,
});
export const CancelSchema = z.strictObject({
  host: z.string(),
  job_id: z.string(),
  system: z.boolean().optional(),
});
export const ReplySchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), job_id: z.string() }),
  z.object({
    ok: z.literal(false),
    status: z.number().int().min(400).max(599),
    error: z.string(),
  }),
]);
const errors: Record<string, string> = {
  revision_conflict:
    /*i18n*/ "节点曲线已被其他操作修改，请重新载入后比较草稿。",
  task_active: /*i18n*/ "节点已有活动任务，请先等待完成或取消。",
  invalid_policy: /*i18n*/ "曲线或响应参数无效，请检查标记的字段。",
  unsupported_policy: /*i18n*/ "此节点不支持所选控制参数。",
  sensor_unavailable: /*i18n*/ "温度传感器缺失或数据过期，控制操作未执行。",
  thermal_guard: /*i18n*/ "温度达到保护线，任务已中止并恢复温控。",
  restore_failed: /*i18n*/ "恢复系统控制未能确认，请立即检查节点。",
  apply_not_confirmed: /*i18n*/ "未能确认曲线生效，已尝试恢复之前的配置。",
  diagnostic_write_denied: /*i18n*/ "此 SMC 键未获节点管理员授权写入。",
  key_value_changed: /*i18n*/ "SMC 当前值已变化，诊断写入未执行。",
  task_failed: /*i18n*/ "任务未通过，请查看诊断记录。",
  task_timeout: /*i18n*/ "任务超时，已停止进程并执行恢复。",
  daemon_unresponsive: /*i18n*/ "温控守护进程未响应，操作未继续。",
  cancelled: /*i18n*/ "任务已取消。",
  revision_not_found: /*i18n*/ "所选曲线版本已不在节点历史中。",
  request_id_conflict: /*i18n*/ "操作编号已被使用，请重新提交。",
};
export const errorText = (code: string) =>
  errors[code] ?? /*i18n*/ "风扇操作未完成，请查看节点任务记录。";
