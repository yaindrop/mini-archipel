import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputRequestSchema } from "../src/input-contracts.ts";
import { desktopAutomationPlugin } from "../src/server.ts";
import type { PluginContext } from "../../../../console/src/plugins/runtime.ts";
import {
  config,
  TOKEN,
  makeHost,
  makeSnapshot,
} from "../../../../console/tests/fixtures.ts";
import { desktopFixture } from "./desktop-fixture.ts";
import { createApp } from "../../../../console/src/app.ts";

const target = {
  bundle_id: "com.example.editor",
  pid: 42,
  window_id: 7,
  frame: { x: 0, y: 0, width: 800, height: 600 },
  observed_at_ms: 1000,
};
const request = {
  request_id: "input-1",
  operation: "input",
  mode: "preflight",
  target,
  coordinates: { space: "window", unit: "points" },
  action: { kind: "move", x: 100, y: 200 },
};
const reply = (status = "completed") => ({
  ok: true,
  job: {
    id: "input-1",
    operation: "input",
    status,
    created_at: 1,
    updated_at: 2,
    error: null,
  },
});
function fixture() {
  const host = makeHost(),
    data = desktopFixture();
  if (!data.toolkit) throw Error("fixture");
  if (!host.snapshot) throw Error("fixture");
  host.snapshot.plugins.automation = {
    version: 1,
    enabled: true,
    status: "ready",
    ts: Date.now(),
    error: null,
    data,
  };
  const command = vi.fn().mockResolvedValue(reply());
  const context = {
    hosts: () => [host],
    pollHost: vi.fn().mockResolvedValue(undefined),
    command,
  } as unknown as PluginContext;
  return {
    host,
    data,
    toolkit: data.toolkit,
    command,
    plugin: desktopAutomationPlugin.create(context, {}),
  };
}
afterEach(() => vi.useRealTimers());
describe("native input boundary", () => {
  it("validates native action semantics and timeout before dispatch", () => {
    expect(InputRequestSchema.safeParse(request).success).toBe(true);
    expect(
      InputRequestSchema.safeParse({
        ...request,
        timeout: 2,
        action: { kind: "mouseHold", x: 1, y: 1 },
      }).success,
    ).toBe(false);
    for (const action of [
      { kind: "key" },
      { kind: "key", key: "a", key_code: 0 },
      { kind: "key", key: "unknown" },
      { kind: "scroll", x: 1, y: 1, delta_y: 0 },
      { kind: "text", text: "" },
      { kind: "text", text: "😀".repeat(8001) },
      { kind: "move", x: 1, y: 1, modifiers: ["command"] },
      {
        kind: "drag",
        points: [
          { t: 0, x: 1, y: 1 },
          { t: 0, x: 2, y: 2 },
        ],
      },
      { kind: "mouseHold", x: 1, y: 1, hold_seconds: 60 },
      { kind: "click", x: 1, y: 1, unknown: true },
    ])
      expect(
        InputRequestSchema.safeParse({ ...request, action }).success,
        JSON.stringify(action.kind),
      ).toBe(false);
    expect(
      InputRequestSchema.safeParse({
        ...request,
        coordinates: { space: "screen", unit: "pixels" },
      }).success,
    ).toBe(false);
    expect(
      InputRequestSchema.safeParse({
        ...request,
        timeout: 120,
        action: { kind: "text", text: "x".repeat(16000), text_chunk_units: 20 },
      }).success,
    ).toBe(true);
    expect(
      InputRequestSchema.safeParse({
        ...request,
        timeout: 120,
        action: { kind: "text", text: "x".repeat(16000) },
      }).success,
    ).toBe(false);
  });
  it("keeps control hit guards optional and pointer-only", () => {
    const guarded = {
      ...request,
      target: { ...target, hit_text: "Save", hit_role: "AXButton" },
    };
    expect(InputRequestSchema.safeParse(guarded).success).toBe(true);
    for (const action of [
      { kind: "activate" },
      { kind: "text", text: "hello" },
      { kind: "key", key: "Return" },
    ])
      expect(InputRequestSchema.safeParse({ ...guarded, action }).success).toBe(
        false,
      );
    expect(
      InputRequestSchema.safeParse({
        ...request,
        target: { ...target, hit_text: "" },
      }).success,
    ).toBe(false);
  });
  it("accepts all declared native actions including independent activation", () => {
    const native = JSON.parse(
      readFileSync(
        new URL("../../runtime/input-protocol.json", import.meta.url),
        "utf8",
      ),
    ) as {
      properties: {
        action: { oneOf: { properties: { kind: { const: string } } }[] };
      };
    };
    const examples: Record<string, unknown> = {
      activate: { kind: "activate" },
      move: request.action,
      drag: {
        kind: "drag",
        points: [
          { t: 0, x: 1, y: 1 },
          { t: 4, x: 2, y: 2 },
        ],
      },
      text: { kind: "text", text: "你好😀" },
      key: { kind: "key", key: "Return", modifiers: ["command"] },
      scroll: { kind: "scroll", x: 1, y: 1, delta_y: -10 },
    };
    for (const kind of [
      "click",
      "doubleClick",
      "rightClick",
      "middleClick",
      "mouseHold",
    ])
      examples[kind] = { kind, x: 1, y: 2 };
    expect(Object.keys(examples).sort()).toEqual(
      native.properties.action.oneOf.map((a) => a.properties.kind.const).sort(),
    );
    for (const action of Object.values(examples))
      expect(InputRequestSchema.safeParse({ ...request, action }).success).toBe(
        true,
      );
  });
  it("permits inspection and preflight without control or script privilege", async () => {
    const { plugin, data, toolkit, command, host } = fixture();
    data.control_allowed = false;
    data.scripts_allowed = false;
    await plugin.action("submit", { host: host.name, request });
    expect(command).toHaveBeenLastCalledWith(
      host.name,
      "plugins/automation/actions/submit",
      request,
    );
    await expect(
      plugin.action("submit", {
        host: host.name,
        request: { ...request, mode: "execute" },
      }),
    ).rejects.toMatchObject({ status: 403 });
    command.mockClear();
    toolkit.capabilities = [];
    await expect(
      plugin.action("submit", { host: host.name, request }),
    ).rejects.toMatchObject({ status: 503 });
    expect(command).not.toHaveBeenCalled();
  });
  it("stops and resumes while busy, forwarding only explicit stop state", async () => {
    const { plugin, toolkit, command, host } = fixture();
    toolkit.desktop_busy = true;
    for (const stopped of [true, false]) {
      command.mockResolvedValue({ ok: true, stopped });
      await plugin.action("input-stop", { host: host.name, stopped });
      expect(command).toHaveBeenLastCalledWith(
        host.name,
        "plugins/automation/actions/input-stop",
        { stopped },
      );
    }
    expect(command).toHaveBeenCalledTimes(2);
  });
  it("wait polls the same job without resubmission or cancellation", async () => {
    vi.useFakeTimers();
    const { plugin, data, command, host } = fixture();
    data.control_allowed = false;
    command.mockResolvedValueOnce(reply("running")).mockResolvedValue(reply());
    const waiting = plugin.action("wait", {
      host: host.name,
      request_id: "input-1",
      timeout_ms: 1000,
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(await waiting).toEqual(reply());
    expect(command.mock.calls).toEqual([
      [host.name, "plugins/automation/actions/get", { request_id: "input-1" }],
      [host.name, "plugins/automation/actions/get", { request_id: "input-1" }],
    ]);
  });
  it("returns an unfinished job at wait expiry, without interrupting it", async () => {
    vi.useFakeTimers();
    const { plugin, command, host } = fixture();
    command.mockResolvedValue(reply("running"));
    const waiting = plugin.action("wait", {
      host: host.name,
      request_id: "input-1",
      timeout_ms: 500,
    });
    await vi.advanceTimersByTimeAsync(600);
    expect(await waiting).toEqual(reply("running"));
    expect(
      command.mock.calls.every(
        (call) => call[1] === "plugins/automation/actions/get",
      ),
    ).toBe(true);
  });
  it("authenticates and forwards a >16KiB timed path through the real API route", async () => {
    const snapshot = makeSnapshot();
    snapshot.plugins.automation = {
      version: 1,
      enabled: true,
      status: "ready",
      ts: Date.now(),
      error: null,
      data: desktopFixture(),
    };
    const transport = vi.fn((url: string) =>
      Promise.resolve(url.endsWith("/snapshot") ? snapshot : reply()),
    );
    const { app } = createApp(
      { ...config, plugins: { automation: { enabled: true, options: {} } } },
      {
        webDir: mkdtempSync(join(tmpdir(), "automation-console-02-")),
        transport,
        startPolling: false,
        plugins: [desktopAutomationPlugin],
      },
    );
    try {
      const body = {
        host: config.hosts[0]?.name,
        request: {
          ...request,
          timeout: 120,
          action: {
            kind: "drag",
            points: Array.from({ length: 1000 }, (_, i) => ({
              t: i / 100,
              x: i,
              y: i,
            })),
          },
        },
      };
      expect(JSON.stringify(body).length).toBeGreaterThan(16384);
      const options = {
        method: "POST" as const,
        url: "/api/plugins/automation/actions/submit",
        payload: body,
      };
      expect((await app.inject(options)).statusCode).toBe(401);
      const result = await app.inject({
        ...options,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(result.statusCode, result.body).toBe(200);
    } finally {
      await app.close();
    }
  });
});
