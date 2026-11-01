import { z } from "zod";
import { UpstreamError } from "../../../../console/src/archipel.ts";
import type { PluginDefinition } from "../../../../console/src/plugins/runtime.ts";
import {
  ActionSchema,
  ArtifactSchema,
  ReplySchema,
  readonlyAction,
} from "./contracts.ts";
import { recorderCurrent, recorderData } from "./domain.ts";
export const screenRecorderPlugin: PluginDefinition = {
  id: "screen-recording",
  label: /*i18n*/ "屏幕录制",
  version: "1.0.0",
  description: /*i18n*/ "节点屏幕或窗口录制、系统授权及独立鼠标轨道。",
  create(context, options) {
    z.strictObject({}).parse(options);
    return {
      read: () => ({}),
      start() {
        /* The node companion owns accepted recordings. */
      },
      stop() {
        /* Disabling observation never stops an accepted recording. */
      },
      async action(action, body) {
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          "action" in body
        )
          throw new UpstreamError(400, /*i18n*/ "录屏操作参数无效");
        const parsed = ActionSchema.safeParse({ ...body, action });
        if (!parsed.success)
          throw new UpstreamError(400, /*i18n*/ "录屏操作参数无效");
        const request = parsed.data;
        await context.pollHost(request.host);
        const host = context.hosts().find((h) => h.name === request.host);
        if (!host) throw new UpstreamError(404, /*i18n*/ "节点不存在");
        if (!recorderCurrent(host))
          throw new UpstreamError(409, /*i18n*/ "节点或录屏插件未就绪");
        const state = recorderData(host);
        if (state?.availability === "unsupported")
          throw new UpstreamError(409, /*i18n*/ "此节点不支持屏幕录制");
        if (!readonlyAction(action) && !state?.control_allowed)
          throw new UpstreamError(403, /*i18n*/ "节点尚未启用录屏控制");
        const payload =
          request.action === "start"
            ? request.request
            : Object.fromEntries(
                Object.entries(request).filter(
                  ([key]) => key !== "host" && key !== "action",
                ),
              );
        const result = await context.command(
          host.name,
          `plugins/screen-recording/actions/${action}`,
          payload,
        );
        const reply =
          action === "artifact"
            ? ArtifactSchema.parse(result)
            : ReplySchema.parse(result);
        if (action !== "artifact") await context.pollHost(host.name);
        return reply;
      },
    };
  },
};
