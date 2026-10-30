import { describe, it, expect, vi } from "vitest";
import { JobRequestSchema } from "../../src/plugins/desktop-automation/contracts.ts";
import {
  desktopCurrent,
  desktopData,
} from "../../src/plugins/desktop-automation/domain.ts";
import { desktopAutomationPlugin } from "../../src/plugins/desktop-automation/server.ts";
import type { PluginContext } from "../../src/plugins/runtime.ts";
import { makeHost } from "../fixtures.ts";
import { desktopFixture } from "./desktop-fixture.ts";

function fixture() {
  const host = makeHost(),
    data = desktopFixture();
  if (!host.snapshot) throw Error("fixture missing");
  host.snapshot.plugins["desktop-automation"] = {
    enabled: true,
    version: 1,
    status: "ready",
    ts: Date.now(),
    error: null,
    data,
  };
  const command = vi.fn().mockResolvedValue({
    ok: true,
    job: {
      id: "job-1",
      operation: "chat",
      status: "queued",
      created_at: 1,
      updated_at: 1,
      error: null,
    },
    reused: false,
  });
  const context = {
    hosts: () => [host],
    pollHost: vi.fn().mockResolvedValue(undefined),
    command,
  } as unknown as PluginContext;
  return {
    host,
    data,
    command,
    plugin: desktopAutomationPlugin.create(context, {}),
  };
}

describe("desktop automation boundary", () => {
  it("rejects injection, incomplete chat operations and unknown fields", () => {
    for (const input of [
      { request_id: "../job", operation: "doctor" },
      { request_id: "--help", operation: "doctor" },
      { request_id: "job", operation: "doctor", shell: "whoami" },
      {
        request_id: "job",
        operation: "chat",
        app: "codex",
        mode: "new",
        message: "x",
      },
      {
        request_id: "job",
        operation: "chat",
        app: "codex",
        mode: "send",
        target: "id",
      },
      {
        request_id: "job",
        operation: "script",
        mode: "exec",
        path: "relative",
      },
    ])
      expect(JobRequestSchema.safeParse(input).success).toBe(false);
  });
  it("isolates unsupported and stale plugin data", () => {
    const { host } = fixture();
    expect(desktopData(host)?.availability).toBe("ready");
    expect(desktopCurrent(host)).toBe(true);
    expect(desktopCurrent(host, Date.now() + 60000)).toBe(false);
    if (!host.snapshot) throw Error("fixture");
    host.snapshot.plugins["desktop-automation"] = {
      version: 20,
      enabled: true,
      status: "ready",
      ts: Date.now(),
      error: null,
      data: {},
    };
    expect(desktopData(host)).toBeNull();
  });
  it("forwards only validated node payloads with stable IDs", async () => {
    const { host, command, plugin } = fixture();
    const request = {
      request_id: "job-1",
      operation: "chat",
      app: "codex",
      mode: "read",
      target: "thread",
    };
    await plugin.action("submit", { host: host.name, request });
    expect(command).toHaveBeenCalledWith(
      host.name,
      "plugins/desktop-automation/actions/submit",
      request,
    );
    await expect(
      plugin.action("submit", { host: host.name, request, action: "status" }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("separately gates control and arbitrary scripts, while allowing diagnostics", async () => {
    const { data, host, plugin, command } = fixture();
    data.control_allowed = false;
    await expect(
      plugin.action("coordinate", { host: host.name, paused: true }),
    ).rejects.toMatchObject({ status: 403 });
    data.control_allowed = true;
    data.scripts_allowed = false;
    await expect(
      plugin.action("submit", {
        host: host.name,
        request: {
          request_id: "job-1",
          operation: "script",
          mode: "exec",
          path: "/bin/echo",
        },
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(command).not.toHaveBeenCalled();
    data.control_allowed = false;
    command.mockResolvedValue({ ok: true, report: { redacted: true } });
    expect(await plugin.action("diagnostics", { host: host.name })).toEqual({
      ok: true,
      report: { redacted: true },
    });
  });
});
