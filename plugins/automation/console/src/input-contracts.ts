import { z } from "zod";
const duration = z.number().min(0).max(30);
const common = {
  kind: z.string(),
  easing: z.enum(["linear", "smoothstep", "smootherstep"]).optional(),
  modifiers: z
    .array(z.enum(["command", "shift", "option", "control"]))
    .max(4)
    .refine((x) => new Set(x).size === x.length)
    .optional(),
};
const motion = {
  move_seconds: duration.optional(),
  settle_seconds: z.number().min(0).max(5).optional(),
};
const point = {
  x: z.number().min(-100000).max(100000),
  y: z.number().min(-100000).max(100000),
};
const button = z.enum(["left", "right", "middle"]).optional();
const hold = z.number().min(0.01).max(60).optional();
const keyNames = [
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
  "i",
  "j",
  "k",
  "l",
  "m",
  "n",
  "o",
  "p",
  "q",
  "r",
  "s",
  "t",
  "u",
  "v",
  "w",
  "x",
  "y",
  "z",
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "Return",
  "Tab",
  "space",
  "delete",
  "Escape",
  "Left",
  "Right",
  "Up",
  "Down",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ForwardDelete",
  "equal",
  "minus",
  "rightBracket",
  "leftBracket",
  "quote",
  "semicolon",
  "backslash",
  "comma",
  "slash",
  "period",
  "grave",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
] as const;
const action = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("activate") }),
    z.strictObject({ ...common, ...motion, ...point, kind: z.literal("move") }),
    ...(
      [
        "click",
        "doubleClick",
        "middleClick",
        "rightClick",
        "mouseHold",
      ] as const
    ).map((kind) =>
      z.strictObject({
        ...common,
        ...motion,
        ...point,
        kind: z.literal(kind),
        button,
        hold_seconds: hold,
      }),
    ),
    z.strictObject({
      ...common,
      ...motion,
      kind: z.literal("drag"),
      button,
      points: z
        .array(z.strictObject({ t: z.number().min(0).max(60), ...point }))
        .min(2)
        .max(1000)
        .refine(
          (p) =>
            p[0]?.t === 0 &&
            (p.at(-1)?.t ?? 0) >= 0.1 &&
            p.every((v, i) => i === 0 || v.t > (p[i - 1]?.t ?? 0)),
        ),
    }),
    z.strictObject({
      ...common,
      ...motion,
      ...point,
      kind: z.literal("scroll"),
      delta_x: z.number().int().min(-10000).max(10000).optional(),
      delta_y: z.number().int().min(-10000).max(10000).optional(),
      duration: z.number().min(0.05).max(60).optional(),
    }),
    z.strictObject({
      ...common,
      kind: z.literal("key"),
      key: z.enum(keyNames).optional(),
      key_code: z.number().int().min(0).max(127).optional(),
      hold_seconds: hold,
    }),
    z.strictObject({
      ...common,
      kind: z.literal("text"),
      text: z.string().min(1).max(16000),
      text_chunk_units: z.number().int().min(1).max(20).optional(),
    }),
  ])
  .superRefine((a, ctx) => {
    if (
      (a.kind === "move" || a.kind === "text") &&
      "modifiers" in a &&
      a.modifiers?.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Move-only/text cannot hold modifiers",
      });
    if (a.kind === "scroll" && !(a.delta_x ?? 0) && !(a.delta_y ?? 0))
      ctx.addIssue({ code: "custom", message: "Nonzero scroll required" });
    if (a.kind === "key" && (a.key == null) === (a.key_code == null))
      ctx.addIssue({ code: "custom", message: "Specify one key or key code" });
  });
export const InputTargetSchema = z.strictObject({
  bundle_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/),
  pid: z.number().int().min(1).max(2147483647),
  window_id: z.number().int().min(1).max(4294967295),
  frame: z.strictObject({
    ...point,
    width: z.number().positive().max(100000),
    height: z.number().positive().max(100000),
  }),
  observed_at_ms: z.number().min(1).max(1e16),
  title: z.string().max(1000).optional(),
  hit_text: z.string().min(1).max(1000).optional(),
  hit_role: z.string().min(1).max(100).optional(),
});
export const InputRequestSchema = z
  .strictObject({
    request_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/),
    operation: z.literal("input"),
    mode: z.enum(["preflight", "execute"]),
    timeout: z.number().int().min(1).max(120).optional(),
    target: InputTargetSchema,
    coordinates: z
      .strictObject({
        space: z.enum(["screen", "window"]),
        unit: z.enum(["points", "pixels"]),
        display_id: z.number().int().min(1).max(4294967295).optional(),
      })
      .refine((c) => c.unit !== "pixels" || c.display_id != null),
    action,
  })
  .superRefine((r, ctx) => {
    const a = r.action;
    if (
      (r.target.hit_text != null || r.target.hit_role != null) &&
      ["text", "key", "activate"].includes(a.kind)
    )
      ctx.addIssue({
        code: "custom",
        message: "Hit guards require a pointer action",
      });
    let seconds = 0;
    if (
      [
        "move",
        "click",
        "doubleClick",
        "middleClick",
        "rightClick",
        "mouseHold",
        "drag",
        "scroll",
      ].includes(a.kind)
    )
      seconds =
        ("move_seconds" in a ? (a.move_seconds ?? 1) : 1) +
        ("settle_seconds" in a ? (a.settle_seconds ?? 0.2) : 0.2);
    if (a.kind === "drag") seconds += a.points.at(-1)?.t ?? 0;
    if (a.kind === "scroll") seconds += a.duration ?? 0.5;
    if (a.kind === "key") seconds += a.hold_seconds ?? 0.06;
    if (
      a.kind === "click" ||
      a.kind === "middleClick" ||
      a.kind === "rightClick" ||
      a.kind === "mouseHold"
    )
      seconds += a.hold_seconds ?? (a.kind === "mouseHold" ? 1 : 0.08);
    if (a.kind === "doubleClick")
      seconds += 2 * (a.hold_seconds ?? 0.08) + 0.12;
    if (a.kind === "text") {
      let units = 0,
        chunks = 1;
      for (const character of a.text) {
        if (units && units + character.length > (a.text_chunk_units ?? 1)) {
          chunks++;
          units = 0;
        }
        units += character.length;
      }
      seconds += chunks * 0.06;
    }
    if (seconds + 0.25 >= (r.timeout ?? 15))
      ctx.addIssue({
        code: "custom",
        message: "Action exceeds bounded timeout",
      });
  });
export const InputInfoSchema = z.looseObject({
  ok: z.boolean(),
  protocol_version: z.literal(1),
  actions: z.array(z.string()),
  target: InputTargetSchema.nullable(),
  applications: z.array(
    z.object({
      pid: z.number().int().positive(),
      bundle_id: z.string(),
      name: z.string(),
    }),
  ),
  windows: z.array(InputTargetSchema),
  displays: z.array(
    z.object({
      id: z.number().int().positive(),
      frame: z.object({
        ...point,
        width: z.number().positive(),
        height: z.number().positive(),
      }),
      pixel_width: z.number().positive(),
      pixel_height: z.number().positive(),
    }),
  ),
  reason: z.string().optional(),
  permissions: z.object({
    accessibility: z.boolean(),
    post_events: z.boolean(),
  }),
});
export const InputLogSchema = z.object({
  ok: z.literal(true),
  request_id: z.string(),
  events: z.array(z.record(z.string(), z.unknown())),
  offset: z.number().int().nonnegative(),
  next_offset: z.number().int().nonnegative(),
  total_events: z.number().int().nonnegative(),
});
export const InputStopSchema = z.object({
  ok: z.literal(true),
  stopped: z.boolean(),
});
