import { describe, expect, it, vi } from "vitest";
import { screenRecordingPlugin } from "../src/server.ts";
import { StartSchema } from "../src/contracts.ts";
import { recorderCurrent, recordingId } from "../src/domain.ts";
import { makeHost } from "../../../../console/tests/fixtures.ts";
import type { PluginContext } from "../../../../console/src/plugins/runtime.ts";

function fixture() {
  const host = makeHost();
  if (!host.snapshot) throw Error("fixture missing");
  const permission = {
    status: "unchecked",
    checked_at: null,
    requested_at: null,
    message: null,
  };
  const data = {
    availability: "ready",
    control_allowed: true,
    interval_ms: 3000,
    output_directory: "/tmp/recordings",
    backups: [],
    package_available: true,
    recorder: {
      schemaVersion: 1,
      ok: true,
      code: "idle",
      message: "",
      state: "idle",
    },
    error: null,
    permissions: { screen: permission, input: permission },
  };
  host.snapshot.plugins["screen-recording"] = {
    version: 1,
    enabled: true,
    status: "ready",
    ts: Date.now(),
    data,
    error: null,
  };
  const command = vi.fn().mockResolvedValue({
    schemaVersion: 1,
    ok: true,
    code: "stop_requested",
    message: "",
    state: "pending",
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
    plugin: screenRecordingPlugin.create(context, {}),
  };
}
describe("screen recording boundary", () => {
  it("rejects conflicting targets, paths and implicit permission requests", async () => {
    expect(
      StartSchema.safeParse({
        request_id: crypto.randomUUID(),
        window: 1,
        display: 2,
        duration: 18,
      }).success,
    ).toBe(false);
    const { plugin, command } = fixture();
    for (const [action, body] of [
      ["authorize", { host: "yd-mini" }],
      [
        "start",
        {
          host: "yd-mini",
          request: { request_id: "../../movie", duration: 18 },
        },
      ],
      [
        "artifact",
        { host: "yd-mini", recording_id: "../../movie", kind: "video" },
      ],
    ] as const)
      await expect(plugin.action(action, body)).rejects.toMatchObject({
        status: 400,
      });
    expect(command).not.toHaveBeenCalled();
  });
  it("allows quiet checks while control is disabled but gates mutation", async () => {
    const { plugin, data, host, command } = fixture();
    data.control_allowed = false;
    await plugin.action("doctor", { host: host.name });
    expect(command).toHaveBeenCalledWith(
      host.name,
      "plugins/screen-recording/actions/doctor",
      {},
    );
    await expect(
      plugin.action("authorize", { host: host.name, interactive: true }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      plugin.action("stop", { host: host.name }),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("keeps pending stop distinct from completion and rejects stale nodes", async () => {
    const { plugin, host } = fixture();
    await expect(
      plugin.action("stop", { host: host.name }),
    ).resolves.toMatchObject({ code: "stop_requested", state: "pending" });
    host.online = false;
    expect(recorderCurrent(host)).toBe(false);
    await expect(
      plugin.action("start", {
        host: host.name,
        request: { request_id: crypto.randomUUID(), duration: 18 },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(recordingId("/tmp/00000000-0000-4000-8000-000000000001.mp4")).toBe(
      "00000000-0000-4000-8000-000000000001",
    );
    expect(recordingId("/tmp/unowned.mp4")).toBeNull();
  });
});
