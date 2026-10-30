import { z } from "zod";
import { UpstreamError } from "../../archipel.ts";
import type { PluginDefinition } from "../runtime.ts";
import {
  ActionSchema,
  JobReplySchema,
  StateReplySchema,
  DiagnosticReplySchema,
} from "./contracts.ts";
import { desktopCurrent, desktopData } from "./domain.ts";

export const desktopAutomationPlugin: PluginDefinition = {
  id: "desktop-automation",
  label: /*i18n*/ "桌面自动化",
  version: "1.0.0",
  description: /*i18n*/ "节点桌面授权、脚本与聊天操作、后台任务和诊断。",
  create(context, options) {
    z.strictObject({}).parse(options);
    return {
      read: () => ({}),
      start() {
        /* Node-local workers own accepted jobs. */
      },
      stop() {
        /* Disabling the plugin does not cancel accepted jobs. */
      },
      async action(action, body) {
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          "action" in body
        )
          throw new UpstreamError(400, /*i18n*/ "桌面操作参数无效");
        const input = ActionSchema.safeParse({ ...body, action });
        if (!input.success)
          throw new UpstreamError(400, /*i18n*/ "桌面操作参数无效");
        const request = input.data;
        await context.pollHost(request.host);
        const host = context.hosts().find((item) => item.name === request.host);
        if (!host) throw new UpstreamError(404, /*i18n*/ "节点不存在");
        if (!desktopCurrent(host))
          throw new UpstreamError(409, /*i18n*/ "节点或桌面插件未就绪");
        const state = desktopData(host);
        if (state?.availability !== "ready")
          throw new UpstreamError(503, /*i18n*/ "请先在节点安装桌面工具包");
        const readonly =
          ["get", "status", "diagnostics"].includes(action) ||
          (request.action === "submit" &&
            request.request.operation === "doctor");
        if (!readonly && !state.control_allowed)
          throw new UpstreamError(403, /*i18n*/ "节点尚未启用桌面控制");
        if (
          request.action === "submit" &&
          request.request.operation === "script" &&
          !state.scripts_allowed
        )
          throw new UpstreamError(403, /*i18n*/ "节点尚未启用脚本执行");
        const forwarded =
          request.action === "submit"
            ? request.request
            : "request_id" in request
              ? { request_id: request.request_id }
              : "paused" in request
                ? { paused: request.paused }
                : {};
        const result = await context.command(
          host.name,
          `plugins/desktop-automation/actions/${action}`,
          forwarded,
        );
        const parsed =
          action === "status" || action === "coordinate"
            ? StateReplySchema.parse(result)
            : action === "diagnostics"
              ? DiagnosticReplySchema.parse(result)
              : JobReplySchema.parse(result);
        await context.pollHost(host.name);
        return parsed;
      },
    };
  },
};
