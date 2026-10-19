import { z } from "zod";
import type { PluginDefinition } from "../runtime.ts";
import { UpstreamError } from "../../archipel.ts";
import { stale } from "../../domain.ts";
import {
  CancelSchema,
  SubmitSchema,
  ReplySchema,
  errorText,
} from "./contracts.ts";
import { readyState } from "./domain.ts";
export const fanControlPlugin: PluginDefinition = {
  id: "fan-control",
  label: /*i18n*/ "风扇控制",
  version: "1.0.0",
  description:
    /*i18n*/ "节点风扇曲线、实时传感器、限时控制与可取消的硬件诊断。",
  create(context, options) {
    z.strictObject({}).parse(options);
    return {
      read: () => ({}),
      start() {
        /* Local node owns the independent temperature service. */
      },
      stop() {
        /* Disabling observation must not stop temperature control. */
      },
      async action(action, body) {
        if (action !== "command" && action !== "cancel")
          throw new UpstreamError(404, /*i18n*/ "插件操作不存在");
        const input = (
          action === "command" ? SubmitSchema : CancelSchema
        ).safeParse(body);
        if (!input.success)
          throw new UpstreamError(400, /*i18n*/ "风扇操作参数无效");
        const { host: name, ...request } = input.data;
        await context.pollHost(name);
        const host = context.hosts().find((h) => h.name === name);
        if (!host) throw new UpstreamError(404, /*i18n*/ "节点不存在");
        if (host.kind === "virtual")
          throw new UpstreamError(409, /*i18n*/ "虚拟机无硬件风扇");
        if (stale(host, Date.now()))
          throw new UpstreamError(409, /*i18n*/ "节点离线，操作未执行");
        const state = readyState(host);
        if (!state)
          throw new UpstreamError(
            503,
            /*i18n*/ "风扇控制端未就绪，请检查节点安装与插件状态。",
          );
        if (!state.control_allowed)
          throw new UpstreamError(
            403,
            /*i18n*/ "此节点仅允许查看风扇，尚未授权控制。",
          );
        const forwarded =
          "command" in request
            ? {
                request_id: request.request_id,
                expected_revision: request.expected_revision,
                action: request.command.action,
                data: request.command.data,
              }
            : request;
        const result = ReplySchema.parse(
          await context.command(
            name,
            `plugins/fan-control/actions/${action}`,
            forwarded,
          ),
        );
        if (!result.ok)
          throw new UpstreamError(result.status, errorText(result.error));
        await context.pollHost(name);
        return { ok: true };
      },
    };
  },
};
