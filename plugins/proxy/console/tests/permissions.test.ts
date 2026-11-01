import { describe, it, expect, vi } from "vitest";
import { miniProxyPlugin } from "../src/server.ts";
import type { PluginContext } from "../../../../console/src/plugins/runtime.ts";
import { makeHost } from "../../../../console/tests/fixtures.ts";
describe("proxy permission boundary", () => {
  it("forwards read-only capability checks even without a ready/control snapshot", async () => {
    const host = makeHost();
    if (!host.snapshot) throw Error("fixture");
    host.snapshot.plugins.proxy = {
      version: 1,
      enabled: true,
      status: "starting",
      ts: Date.now(),
      error: null,
      data: { control_allowed: false },
    };
    const command = vi.fn().mockResolvedValue({ ok: true, permissions: {} });
    const context: PluginContext = {
      hosts: () => [host],
      pollHost: vi.fn().mockResolvedValue(undefined),
      command,
      transport: vi.fn(),
    };
    const instance = miniProxyPlugin.create(context, {});
    for (const action of ["permission-check", "permission-request"]) {
      await instance.action(action, {
        host: host.name,
        permission: "user-service",
      });
      expect(command).toHaveBeenLastCalledWith(
        host.name,
        `plugins/proxy/actions/${action}`,
        { permission: "user-service" },
      );
    }
    expect(command).toHaveBeenCalledTimes(2);
  });
  it("rejects unknown permissions and extra command parameters before forwarding", async () => {
    const command = vi.fn();
    const context: PluginContext = {
      hosts: () => [],
      pollHost: vi.fn(),
      command,
      transport: vi.fn(),
    };
    const instance = miniProxyPlugin.create(context, {});
    await expect(
      instance.action("permission-check", {
        host: "node",
        permission: "other",
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      instance.action("permission-request", {
        host: "node",
        permission: "user-service",
        enable: true,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(command).not.toHaveBeenCalled();
  });
});
