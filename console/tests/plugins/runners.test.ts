import { afterEach, describe, expect, it, vi } from "vitest";
import { setupI18n } from "@lingui/core";
import { messages as en } from "../../src/locales/en/messages.po";
import { messages as zh } from "../../src/locales/zh/messages.po";
import {
  OptionsSchema,
  ConsoleDataSchema,
  type GitHubRunner,
} from "../../src/plugins/runners/contracts.ts";
import {
  agentData,
  current,
  runnerState,
  runnersFor,
  repositoryGroups,
  conclusionLabel,
} from "../../src/plugins/runners/domain.ts";
import { runnersPlugin } from "../../src/plugins/runners/server.ts";
import type { PluginContext } from "../../src/plugins/runtime.ts";
import { makeHost, makeSnapshot, fixtureRunnerData } from "../fixtures.ts";
afterEach(() => vi.useRealTimers());
describe("runner plugin domain", () => {
  it("shows local mutual exclusion before stale GitHub state", () => {
    const host = makeHost();
    if (!host.snapshot) throw Error("fixture");
    const data = fixtureRunnerData(host.snapshot),
      runner = data.runners[0];
    if (!runner) throw Error("fixture");
    data.coordination = {
      available: true,
      enabled: true,
      active_repo: "owner/other",
      paused: [runner.repo_dir],
      waiting: [],
      error: null,
    };
    expect(runnerState(host, runner)).toBe("paused");
    data.coordination.paused = [];
    data.coordination.waiting = [runner.repo_dir];
    runner.worker_pid = 123;
    expect(runnerState(host, runner)).toBe("waiting");
    data.coordination.enabled = false;
    expect(runnerState(host, runner)).toBe("busy");
  });
  it("translates unknown repository labels using the current render context", () => {
    const host = makeHost();
    if (!host.snapshot) throw Error("fixture");
    const runner = fixtureRunnerData(host.snapshot).runners[0];
    if (!runner) throw Error("fixture");
    runner.repo = null;
    const context = setupI18n();
    context.loadAndActivate({ locale: "en", messages: en });
    expect(repositoryGroups([host], context._.bind(context))[0]?.label).toBe(
      "Unknown repository · flowbit",
    );
    context.loadAndActivate({ locale: "zh", messages: zh });
    expect(repositoryGroups([host], context._.bind(context))[0]?.label).toBe(
      "未识别仓库 · flowbit",
    );
  });
  it("separates repositories even when runner names, ids and repository leaf names match", () => {
    const host = makeHost(),
      snapshot = host.snapshot;
    if (!snapshot) throw Error("fixture");
    const data = fixtureRunnerData(snapshot),
      first = data.runners[0];
    if (!first) throw Error("fixture");
    data.runners.push({
      ...first,
      repo: "acme/flowbit",
      repo_dir: "acme-flowbit",
    });
    const groups = repositoryGroups([host, makeHost(1)]);
    expect(groups.map((g) => [g.repo, g.rows.length])).toEqual([
      ["acme/flowbit", 1],
      ["yaindrop/flowbit", 2],
    ]);
    expect(
      runnerState(host, first, [
        {
          repo: "acme/flowbit",
          id: first.agent_id ?? 0,
          name: first.agent_name ?? "",
          status: "online",
          busy: true,
          labels: [],
        },
      ]),
    ).toBe("listening");
  });
  it.each([
    "ready",
    "connecting",
    "busy",
    "stopped",
    "listening",
    "unknown",
  ] as const)("distinguishes runner state %s", (status) => {
    const host = makeHost(),
      runner = runnersFor(host)[0];
    if (!runner) throw Error("fixture");
    let remote: GitHubRunner[] = [];
    if (status === "unknown") host.online = false;
    else if (status === "stopped") runner.listener_pid = null;
    else if (status !== "listening")
      remote = [
        {
          repo: "yaindrop/flowbit",
          id: 29,
          name: runner.agent_name ?? "",
          status: status === "connecting" ? "offline" : "online",
          busy: status === "busy",
          labels: [],
        },
      ];
    expect(runnerState(host, runner, remote)).toBe(status);
  });
  it("shows the local explicit run without reading it from GitHub", () => {
    const host = makeHost(),
      runner = runnersFor(host)[0];
    if (!runner?.run) throw Error("fixture");
    expect(runner.run.conclusion).toBe("passed");
    expect(runner.run.env_ok).toBe(true);
    expect(conclusionLabel("passed")).toBe("通过");
    expect(conclusionLabel("environment")).toBe("环境失败");
    expect(conclusionLabel("check")).toBe("项目检查失败");
    expect(conclusionLabel("infrastructure")).toBe("基础设施故障");
    expect(conclusionLabel("interrupted")).toBe("中断");
    expect(conclusionLabel("incomplete")).toBe("未完成");
    expect(
      runnerState(host, runner, [
        {
          repo: "yaindrop/flowbit",
          id: runner.agent_id ?? 0,
          name: runner.agent_name ?? "",
          status: "online",
          busy: false,
          labels: [],
        },
      ]),
    ).toBe("ready");
  });
  it("protects an active Worker even when the matching remote identity reports idle", () => {
    const host = makeHost(3),
      runner = runnersFor(host)[0];
    if (!runner) throw Error("fixture");
    expect(
      runnerState(host, runner, [
        {
          repo: "yaindrop/flowbit",
          id: runner.agent_id ?? 0,
          name: "arbitrary-name",
          status: "online",
          busy: false,
          labels: [],
        },
      ]),
    ).toBe("busy");
  });
  it("handles absent, disabled, incompatible, malformed and stale plugin data independently", () => {
    const host = makeHost();
    expect(current(host)).toBe(true);
    expect(current(host, Date.now() + 16000)).toBe(false);
    if (!host.snapshot) throw Error("fixture");
    for (const envelope of [
      undefined,
      {
        version: 3,
        enabled: true,
        status: "ready",
        ts: Date.now(),
        data: {},
        error: null,
      },
      {
        version: 2,
        enabled: false,
        status: "disabled",
        ts: Date.now(),
        data: null,
        error: null,
      },
      {
        version: 2,
        enabled: true,
        status: "ready",
        ts: Date.now(),
        data: { runners: "broken" },
        error: null,
      },
    ]) {
      host.snapshot.plugins.runners = envelope;
      expect(agentData(host)).toBeNull();
      expect(runnersFor(host)).toEqual([]);
      expect(host.online).toBe(true);
    }
  });
  it("validates GitHub settings within the plugin without exposing credential values", () => {
    expect(OptionsSchema.safeParse({ githubToken: "test-only" }).success).toBe(
      false,
    );
    expect(OptionsSchema.safeParse({ githubRepo: "owner/repo" }).success).toBe(
      false,
    );
    expect(
      OptionsSchema.safeParse({
        repositories: [
          { repo: "owner/repo", token: "one" },
          { repo: "Owner/Repo", token: "two" },
        ],
      }).success,
    ).toBe(false);
    expect(
      OptionsSchema.safeParse({
        repositories: [{ repo: "owner/repo", token: "test-only" }],
      }).success,
    ).toBe(true);
    expect(() =>
      runnersPlugin.create(context(), {
        repositories: [{ repo: "invalid", token: "private-secret" }],
      }),
    ).not.toThrow("private-secret");
    expect(() =>
      runnersPlugin.create(context(), {
        repositories: [{ repo: "invalid", token: "private-secret" }],
      }),
    ).toThrow("repositories");
  });
});
function context(): PluginContext {
  return {
    hosts: () => [makeHost()],
    pollHost: () => Promise.resolve(),
    command: () => Promise.resolve({ ok: true }),
    transport: () =>
      Promise.resolve({
        total_count: 1,
        runners: [
          {
            id: 29,
            name: "remote-name",
            status: "online",
            busy: false,
            labels: [],
          },
        ],
      }),
  };
}
describe("runner plugin integration", () => {
  it("sets a node policy locally, validates input and rejects stale or older nodes", async () => {
    const ctx = context(),
      host = makeHost(),
      other = makeHost(1);
    ctx.hosts = () => [host, other];
    const command = vi.fn(ctx.command),
      transport = vi.fn(ctx.transport);
    ctx.command = command;
    ctx.transport = transport;
    const instance = runnersPlugin.create(ctx, {});
    for (const enable of [true, false]) {
      await expect(
        instance.action("coordination", { host: other.name, enable }),
      ).resolves.toEqual({ ok: true });
      expect(command).toHaveBeenLastCalledWith(
        other.name,
        "plugins/runners/actions/coordination",
        { enable },
      );
    }
    expect(transport).not.toHaveBeenCalled();
    command.mockClear();
    await expect(
      instance.action("coordination", { host: other.name, enable: "true" }),
    ).rejects.toThrow("缺少有效");
    await expect(
      instance.action("coordination", {
        host: other.name,
        enable: true,
        repo: "owner/repo",
      }),
    ).rejects.toThrow("缺少有效");
    if (!other.snapshot) throw Error("fixture");
    delete fixtureRunnerData(other.snapshot).coordination;
    await expect(
      instance.action("coordination", { host: other.name, enable: true }),
    ).rejects.toThrow("更新共用作业钩子");
    expect(command).not.toHaveBeenCalled();
  });
  it("paginates each repository independently and contains failures and credentials", async () => {
    vi.useFakeTimers();
    const ctx = context();
    const transport = vi.fn<PluginContext["transport"]>((url) => {
      if (url.includes("broken/project"))
        return Promise.reject(Error("private-secret"));
      const count = url.endsWith("page=1") ? 100 : 1;
      return Promise.resolve({
        total_count: 101,
        runners: Array.from({ length: count }, (_, i) => ({
          id: i,
          name: `r-${String(i)}`,
          status: "online",
          busy: false,
          labels: [],
        })),
      });
    });
    ctx.transport = transport;
    const instance = runnersPlugin.create(ctx, {
      repositories: [
        { repo: "owner/project", token: "one-private" },
        { repo: "broken/project", token: "two-private" },
      ],
    });
    instance.start();
    await vi.advanceTimersByTimeAsync(0);
    const data = ConsoleDataSchema.parse(instance.read());
    expect(data.repositories[0]?.remote).toHaveLength(101);
    expect(
      data.repositories[0]?.remote.every((r) => r.repo === "owner/project"),
    ).toBe(true);
    expect(data.repositories[1]?.lastError).toBeTruthy();
    expect(data.repositories[1]?.remote).toEqual([]);
    expect(transport).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/project/actions/runners?per_page=100&page=2",
      "one-private",
    );
    expect(JSON.stringify(data)).not.toMatch(/private/);
    instance.stop();
  });
  it("targets the requested repository and installation without confusing duplicate runner names", async () => {
    const ctx = context(),
      host = makeHost(),
      snapshot = host.snapshot;
    if (!snapshot) throw Error("fixture");
    const data = fixtureRunnerData(snapshot),
      first = data.runners[0];
    if (!first) throw Error("fixture");
    first.worker_pid = 999;
    data.runners.push({
      ...first,
      repo: "acme/flowbit",
      repo_dir: "acme-flowbit",
      worker_pid: null,
    });
    ctx.hosts = () => [host];
    const command = vi.fn(ctx.command);
    ctx.command = command;
    const instance = runnersPlugin.create(ctx, {});
    await expect(
      instance.action("toggle", {
        host: host.name,
        repo: "acme/flowbit",
        runner: "acme-flowbit",
        enable: false,
      }),
    ).resolves.toEqual({ ok: true });
    expect(command).toHaveBeenCalledWith(
      host.name,
      "plugins/runners/actions/toggle",
      { repo: "acme/flowbit", runner: "acme-flowbit", enable: false },
    );
    command.mockClear();
    await expect(
      instance.action("toggle", {
        host: host.name,
        repo: "yaindrop/flowbit",
        runner: "acme-flowbit",
        enable: false,
      }),
    ).rejects.toThrow("不存在");
    await expect(
      instance.action("toggle", {
        host: host.name,
        repo: "yaindrop/flowbit",
        runner: "flowbit",
        enable: false,
      }),
    ).rejects.toThrow("正在执行作业");
    expect(command).not.toHaveBeenCalled();
    const transport = vi.fn(ctx.transport);
    ctx.transport = transport;
    await expect(
      instance.action("interrupt", {
        host: host.name,
        repo: "yaindrop/flowbit",
        runner: "flowbit",
        worker_pid: 999,
      }),
    ).resolves.toEqual({ ok: true });
    expect(command).toHaveBeenCalledWith(
      host.name,
      "plugins/runners/actions/interrupt",
      {
        repo: "yaindrop/flowbit",
        runner: "flowbit",
        worker_pid: 999,
      },
    );
    expect(transport).not.toHaveBeenCalled();
  });
  it("owns GitHub polling, expires remote data and stops polling when disabled", async () => {
    vi.useFakeTimers();
    const ctx = context(),
      transport = vi.fn(ctx.transport);
    ctx.transport = transport;
    const instance = runnersPlugin.create(ctx, {
      repositories: [{ repo: "owner/repo", token: "test-only" }],
    });
    instance.start();
    await vi.advanceTimersByTimeAsync(0);
    let data = ConsoleDataSchema.parse(instance.read());
    expect(data.repositories[0]?.remote[0]?.id).toBe(29);
    expect(data.repositories[0]?.repo).toBe("owner/repo");
    expect(transport).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/actions/runners?per_page=100&page=1",
      "test-only",
    );
    vi.setSystemTime(Date.now() + 100000);
    expect(
      ConsoleDataSchema.parse(instance.read()).repositories[0]?.remote,
    ).toEqual([]);
    instance.stop();
    const calls = transport.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(transport).toHaveBeenCalledTimes(calls);
    data = ConsoleDataSchema.parse(instance.read());
    expect(data.repositories[0]?.remote).toEqual([]);
  });
  it("sanitizes GitHub failures without affecting local plugin actions", async () => {
    vi.useFakeTimers();
    const ctx = context();
    ctx.transport = () => Promise.reject(Error("private-secret"));
    const instance = runnersPlugin.create(ctx, {
      repositories: [{ repo: "owner/repo", token: "test-only" }],
    });
    instance.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(
      ConsoleDataSchema.parse(instance.read()).repositories[0]?.lastError,
    ).toBeTruthy();
    expect(JSON.stringify(instance.read())).not.toContain("private-secret");
    await expect(
      instance.action("toggle", {
        host: "yd-mini",
        repo: "yaindrop/flowbit",
        runner: "flowbit",
        enable: true,
      }),
    ).resolves.toEqual({ ok: true });
    instance.stop();
  });
  it("ignores an in-flight GitHub response after plugin stop", async () => {
    const gate = Promise.withResolvers<unknown>(),
      ctx = context();
    ctx.transport = () => gate.promise;
    const instance = runnersPlugin.create(ctx, {
      repositories: [{ repo: "owner/repo", token: "test-only" }],
    });
    instance.start();
    instance.stop();
    gate.resolve({
      total_count: 1,
      runners: [
        { id: 29, name: "late", status: "online", busy: true, labels: [] },
      ],
    });
    await gate.promise;
    await Promise.resolve();
    expect(
      ConsoleDataSchema.parse(instance.read()).repositories[0]?.remote,
    ).toEqual([]);
    expect(
      ConsoleDataSchema.parse(instance.read()).repositories[0]?.lastTs,
    ).toBe(0);
  });
  it("rejects unknown actions and unavailable plugin snapshots", async () => {
    const ctx = context(),
      snapshot = makeSnapshot();
    fixtureRunnerData(snapshot).control_allowed = false;
    const instance = runnersPlugin.create(ctx, {});
    await expect(instance.action("missing", {})).rejects.toThrow("操作不存在");
    ctx.hosts = () => [{ ...makeHost(), snapshot }];
    await expect(
      instance.action("toggle", {
        host: "yd-mini",
        repo: "yaindrop/flowbit",
        runner: "flowbit",
        enable: false,
      }),
    ).rejects.toThrow("尚未授权");
    ctx.hosts = () => [
      { ...makeHost(), snapshot: { ...snapshot, plugins: {} } },
    ];
    await expect(
      instance.action("toggle", {
        host: "yd-mini",
        repo: "yaindrop/flowbit",
        runner: "flowbit",
        enable: false,
      }),
    ).rejects.toThrow("插件数据不可用");
  });
});
