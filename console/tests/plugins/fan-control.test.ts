import { describe, it, expect, vi } from "vitest";
import {
  PolicySchema,
  CommandSchema,
} from "../../src/plugins/fan-control/contracts.ts";
import {
  readyState,
  controllable,
  activeJob,
  withProtectionTemperature,
} from "../../src/plugins/fan-control/domain.ts";
import { fanControlPlugin } from "../../src/plugins/fan-control/server.ts";
import type { PluginContext } from "../../src/plugins/runtime.ts";
import { makeHost } from "../fixtures.ts";
import { fanFixture } from "./fan-fixture.ts";
describe("fan-control boundary", () => {
  it("links the protection point to the temperature and keeps it at maximum RPM", () => {
    const original = fanFixture().policy;
    const next = withProtectionTemperature(original, 80);
    expect(next.critical_temp).toBe(80);
    expect(next.curve.at(-1)).toEqual({ t: 80, rpm: original.max_rpm });
    expect(next.curve.slice(0, -1)).toEqual(original.curve.slice(0, -1));
    expect(original.critical_temp).toBe(70);
    expect(PolicySchema.safeParse(next).success).toBe(true);
    expect(withProtectionTemperature(original, 30).critical_temp).toBe(61);
    expect(withProtectionTemperature(original, 200).critical_temp).toBe(100);
  });
  it("rejects silent fallback policy modes, invalid curves and diagnostic injection", () => {
    const policy = fanFixture().policy;
    for (const patch of [
      { mode: "auto" },
      { up_delay: 1 },
      { sensors: [] },
      { sensors: ["Tp05", "Tp05"] },
      { fans: [0, 0] },
      { critical_temp: 40 },
      {
        curve: [
          { t: 0, rpm: 1000 },
          { t: 70, rpm: 2950 },
        ],
      },
      { alpha_up: NaN },
    ])
      expect(PolicySchema.safeParse({ ...policy, ...patch }).success).toBe(
        false,
      );
    expect(
      CommandSchema.safeParse({
        action: "trywrite",
        data: { key: "../../etc", value: 0, expected_value: 0 },
      }).success,
    ).toBe(false);
  });
  it("keeps node tasks and control rights separate from core monitoring", () => {
    const host = makeHost(),
      state = fanFixture();
    if (!host.snapshot) throw Error("fixture");
    host.snapshot.plugins["fan-control"] = {
      version: 1,
      enabled: true,
      status: "ready",
      ts: Date.now(),
      data: state,
      error: null,
    };
    expect(readyState(host)).toEqual(state);
    expect(controllable(host, state)).toBe(true);
    expect(controllable(host, { ...state, control_allowed: false })).toBe(
      false,
    );
    expect(
      controllable(host, { ...state, sampled_at: Date.now() - 16000 }),
    ).toBe(false);
    expect(activeJob(state)).toBeUndefined();
    host.snapshot.plugins["fan-control"] = {
      ...(host.snapshot.plugins["fan-control"] as Record<string, unknown>),
      version: 2,
    };
    expect(readyState(host)).toBeNull();
  });
  it("forwards typed local operations and maps CAS errors without GitHub", async () => {
    const host = makeHost(),
      state = fanFixture();
    if (!host.snapshot) throw Error("fixture");
    host.snapshot.plugins["fan-control"] = {
      version: 1,
      enabled: true,
      status: "ready",
      ts: Date.now(),
      data: state,
      error: null,
    };
    const command = vi.fn().mockResolvedValue({ ok: true, job_id: "task" });
    const context = {
      hosts: () => [host],
      pollHost: vi.fn().mockResolvedValue(undefined),
      command,
    } as unknown as PluginContext;
    const plugin = fanControlPlugin.create(context, {}),
      body = {
        host: host.name,
        request_id: "8319d88b-3de0-442b-b194-0fe4502c37fe",
        expected_revision: state.revision,
        command: {
          action: "manual",
          data: { rpm: 2170, seconds: 5, method: "force" },
        },
      };
    await plugin.action("command", body);
    expect(command).toHaveBeenCalledWith(
      host.name,
      "plugins/fan-control/actions/command",
      {
        request_id: body.request_id,
        expected_revision: state.revision,
        ...body.command,
      },
    );
    command.mockResolvedValue({
      ok: false,
      status: 409,
      error: "revision_conflict",
    });
    await expect(plugin.action("command", body)).rejects.toThrow(
      "节点曲线已被其他操作修改",
    );
    command.mockClear();
    host.kind = "virtual";
    await expect(plugin.action("command", body)).rejects.toThrow(
      "虚拟机无硬件风扇",
    );
    expect(command).not.toHaveBeenCalled();
  });
});
