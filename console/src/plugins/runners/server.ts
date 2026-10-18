import { z } from "zod";
import { randomUUID } from "node:crypto";
import { OkSchema } from "../../contracts.ts";
import { UpstreamError } from "../../fleet.ts";
import { readEnvelope } from "../contracts.ts";
import type { PluginDefinition } from "../runtime.ts";
import {
  GitHubRunnerSchema,
  OptionsSchema,
  ToggleSchema,
  InterruptSchema,
  CoordinationSchema,
  type RepositoryState,
} from "./contracts.ts";
import { agentData, current, runnerState, runnersFor } from "./domain.ts";
export const runnersPlugin: PluginDefinition = {
  id: "runners",
  label: "Runners",
  version: "2.2.0",
  description: /*i18n*/ "GitHub Actions 接单进程、作业保护、工作区及诊断日志。",
  create(context, rawOptions) {
    const parsed = OptionsSchema.safeParse(rawOptions);
    if (!parsed.success)
      throw new Error(
        `Invalid runners options: ${parsed.error.issues.map((i) => i.path.join(".") || i.message).join("; ")}`,
      );
    const options = parsed.data;
    let generation = 0;
    const refreshing = new Set<string>();
    const repositories: RepositoryState[] = options.repositories.map(
      ({ repo }) => ({
        repo,
        lastTs: 0,
        lastError: null,
        remote: [],
      }),
    );
    let timer: ReturnType<typeof setInterval> | undefined;
    async function refresh(index: number, epoch: number) {
      const settings = options.repositories[index],
        state = repositories[index];
      if (!settings || !state || refreshing.has(settings.repo)) return;
      refreshing.add(settings.repo);
      try {
        const remote: RepositoryState["remote"] = [];
        for (let page = 1; ; page++) {
          const data = z
            .object({
              total_count: z.number().int().nonnegative(),
              runners: z.array(
                GitHubRunnerSchema.omit({
                  repo: true,
                }),
              ),
            })
            .parse(
              await context.transport(
                `https://api.github.com/repos/${settings.repo}/actions/runners?per_page=100&page=${String(page)}`,
                settings.token,
              ),
            );
          if (epoch !== generation) return;
          remote.push(
            ...data.runners.map((runner) => ({
              ...runner,
              repo: settings.repo,
            })),
          );
          if (data.runners.length < 100 || remote.length >= data.total_count)
            break;
        }
        state.remote = remote;
        state.lastTs = Date.now();
        state.lastError = null;
      } catch {
        if (epoch === generation)
          state.lastError =
            /*i18n*/ "GitHub 状态暂不可用，当前展示本地采集结果";
      } finally {
        refreshing.delete(settings.repo);
      }
    }
    const read = () => ({
      repositories: repositories.map((state) => ({
        ...state,
        remote: Date.now() - state.lastTs < 90000 ? state.remote : [],
      })),
    });
    return {
      read,
      start() {
        if (timer) return;
        const epoch = ++generation;
        repositories.forEach((_repo, index) => {
          void refresh(index, epoch);
        });
        timer = setInterval(() => {
          repositories.forEach((_repo, index) => {
            void refresh(index, epoch);
          });
        }, 30000);
      },
      stop() {
        generation++;
        if (timer) clearInterval(timer);
        timer = undefined;
        repositories.forEach((state) => {
          state.remote = [];
          state.lastTs = 0;
        });
      },
      async action(action, body) {
        if (
          action !== "toggle" &&
          action !== "interrupt" &&
          action !== "coordination"
        )
          throw new UpstreamError(404, /*i18n*/ "插件操作不存在");
        const input = (
          action === "coordination"
            ? CoordinationSchema
            : action === "interrupt"
              ? InterruptSchema.extend({ host: z.string() })
              : ToggleSchema.extend({ host: z.string() })
        ).safeParse(body);
        if (!input.success)
          throw new UpstreamError(
            400,
            /*i18n*/ "缺少有效的节点、仓库、安装目录或操作",
          );
        const { host: name } = input.data;
        const requestId = input.data.request_id ?? randomUUID();
        await context.pollHost(name);
        const host = context.hosts().find((h) => h.name === name);
        if (!host) throw new UpstreamError(404, /*i18n*/ "节点不存在");
        if (!current(host))
          throw new UpstreamError(
            409,
            /*i18n*/ "节点或插件数据不可用，操作未执行",
          );
        if (!agentData(host)?.control_allowed)
          throw new UpstreamError(
            403,
            /*i18n*/ "此节点只启用了监控，尚未授权 Runner 服务控制",
          );
        const operationId = agentData(host)?.operations
          ? { request_id: requestId }
          : {};
        if (!("repo" in input.data)) {
          if (!agentData(host)?.coordination?.available)
            throw new UpstreamError(
              409,
              /*i18n*/ "节点接单互斥不可用，请更新共用作业钩子",
            );
          OkSchema.parse(
            await context.command(
              name,
              "plugins/runners/actions/coordination",
              {
                ...operationId,
                enable: input.data.enable,
              },
            ),
          );
          await context.pollHost(name);
          return { ok: true };
        }
        const { repo, runner: directory } = input.data;
        const runner = runnersFor(host).find(
          (r) => r.repo === repo && r.repo_dir === directory,
        );
        if (!runner) throw new UpstreamError(404, /*i18n*/ "runner 不存在");
        if (
          action === "toggle" &&
          "enable" in input.data &&
          input.data.enable &&
          agentData(host)?.coordination?.paused.includes(directory)
        )
          throw new UpstreamError(
            409,
            /*i18n*/ "节点接单互斥中，请等待当前作业结束",
          );
        const freshRemote = read().repositories.flatMap(
          (state) => state.remote,
        );
        if (
          action === "toggle" &&
          runnerState(host, runner, freshRemote) === "busy"
        )
          throw new UpstreamError(
            409,
            /*i18n*/ "runner 正在执行作业，请等待作业结束",
          );
        if (!readEnvelope(host, "runners")?.enabled)
          throw new UpstreamError(409, /*i18n*/ "节点插件未启用");
        OkSchema.parse(
          await context.command(
            name,
            `plugins/runners/actions/${action}`,
            action === "interrupt" && "worker_pid" in input.data
              ? {
                  ...operationId,
                  repo,
                  runner: directory,
                  worker_pid: input.data.worker_pid,
                }
              : {
                  ...operationId,
                  repo,
                  runner: directory,
                  enable: "enable" in input.data ? input.data.enable : false,
                },
          ),
        );
        await context.pollHost(name);
        return {
          ok: true,
        };
      },
    };
  },
};
