import { z } from "zod";
import type { PluginDefinition } from "../../../../console/src/plugins/runtime.ts";
import { UpstreamError } from "../../../../console/src/archipel.ts";
import { stale } from "../../../../console/src/domain.ts";

const NodeName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
const RequestSchema = z.strictObject({
  host: z.string().min(1),
  node: NodeName,
});
const ReplySchema = z.object({
  ok: z.boolean(),
  output: z.string(),
  check_ms: z.number().nonnegative(),
  error: z.string().nullable().optional(),
});

export const miniProxyPlugin: PluginDefinition = {
  id: "proxy",
  label: /*i18n*/ "代理出口",
  version: "1.0.0",
  description: /*i18n*/ "节点出境代理的出口状态、节点测速与受控切换。",
  create(context, options) {
    z.strictObject({}).parse(options);
    return {
      read: () => ({}),
      start() {
        /* The node owns the independent proxy service. */
      },
      stop() {
        /* Disabling observation must not stop the proxy. */
      },
      async action(action, body) {
        if (action === "permission-check" || action === "permission-request") {
          const input = z
            .strictObject({
              host: z.string().min(1),
              permission: z.literal("user-service"),
            })
            .safeParse(body);
          if (!input.success) throw new UpstreamError(400, "权限检查参数无效");
          const name = input.data.host;
          await context.pollHost(name);
          const host = context.hosts().find((item) => item.name === name);
          if (!host) throw new UpstreamError(404, "节点不存在");
          const reply = await context.command(
            name,
            `plugins/proxy/actions/${action}`,
            { permission: input.data.permission },
          );
          await context.pollHost(name);
          return reply;
        }

        if (action !== "switch" && action !== "check")
          throw new UpstreamError(404, /*i18n*/ "插件操作不存在");
        const input = RequestSchema.safeParse(body);
        if (!input.success)
          throw new UpstreamError(400, /*i18n*/ "代理操作参数无效");
        const { host: name, node } = input.data;
        await context.pollHost(name);
        const host = context.hosts().find((h) => h.name === name);
        if (!host) throw new UpstreamError(404, /*i18n*/ "节点不存在");
        if (stale(host, Date.now()))
          throw new UpstreamError(409, /*i18n*/ "节点离线，操作未执行");
        const reply = ReplySchema.parse(
          await context.command(name, `plugins/proxy/actions/${action}`, {
            node,
          }),
        );
        await context.pollHost(name);
        return reply;
      },
    };
  },
};
