import {
  InputInfoSchema,
  InputLogSchema,
  InputStopSchema,
} from "./input-contracts.ts";
import { z } from "zod";
import { UpstreamError } from "../../../../console/src/archipel.ts";
import type { PluginDefinition } from "../../../../console/src/plugins/runtime.ts";
import {
  ActionSchema,
  JobReplySchema,
  StateReplySchema,
  DiagnosticReplySchema,
} from "./contracts.ts";
import { desktopCurrent, desktopData } from "./domain.ts";

export const desktopAutomationPlugin: PluginDefinition = {
  id: "automation",
  label: /*i18n*/ "桌面自动化",
  version: "1.2.0",
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
          [
            "get",
            "wait",
            "status",
            "diagnostics",
            "input-info",
            "input-log",
          ].includes(action) ||
          (request.action === "submit" &&
            (request.request.operation === "doctor" ||
              (request.request.operation === "input" &&
                request.request.mode === "preflight")));
        if (!readonly && !state.control_allowed)
          throw new UpstreamError(403, /*i18n*/ "节点尚未启用桌面控制");
        if (
          request.action === "submit" &&
          request.request.operation === "script" &&
          !state.scripts_allowed
        )
          throw new UpstreamError(403, /*i18n*/ "节点尚未启用脚本执行");
        if (
          (action.startsWith("input-") ||
            (request.action === "submit" &&
              request.request.operation === "input")) &&
          !state.toolkit?.capabilities.includes("input")
        )
          throw new UpstreamError(
            503,
            /*i18n*/ "节点工具包尚不支持原生输入，请升级后重试",
          );
        const forwarded =
          request.action === "submit"
            ? request.request
            : "request_id" in request
              ? {
                  request_id: request.request_id,
                  ...("offset" in request && request.offset != null
                    ? { offset: request.offset }
                    : {}),
                }
              : "stopped" in request
                ? { stopped: request.stopped }
                : "paused" in request
                  ? { paused: request.paused }
                  : {};
        if (request.action === "wait") {
          const deadline = Date.now() + (request.timeout_ms ?? 1000);
          let reply;
          do {
            reply = JobReplySchema.parse(
              await context.command(
                host.name,
                "plugins/automation/actions/get",
                forwarded,
              ),
            );
            if (
              !["queued", "running", "waiting_user"].includes(
                reply.job.status,
              ) ||
              Date.now() >= deadline
            )
              return reply;
            await new Promise((resolve) =>
              setTimeout(
                resolve,
                Math.min(250, Math.max(0, deadline - Date.now())),
              ),
            );
          } while (Date.now() <= deadline);
          return reply;
        }
        const result = await context.command(
          host.name,
          `plugins/automation/actions/${action}`,
          forwarded,
        );
        const parsed =
          action === "input-info"
            ? InputInfoSchema.parse(result)
            : action === "input-log"
              ? InputLogSchema.parse(result)
              : action === "input-stop"
                ? InputStopSchema.parse(result)
                : action === "status" || action === "coordinate"
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
