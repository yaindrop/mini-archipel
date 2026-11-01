import type { Snapshot } from "../../../../console/src/contracts.ts";
import type { RecorderReply } from "../src/contracts.ts";
export function recordingFixture() {
  let enabled = false;
  const permission = () => ({
    status: "unchecked",
    checked_at: null as number | null,
    requested_at: null as number | null,
    message: null as string | null,
  });
  const data = {
    availability: "ready",
    control_allowed: true,
    interval_ms: 3000,
    output_directory: "/tmp/fixture-recordings",
    backups: [],
    package_available: true,
    recorder: {
      schemaVersion: 1,
      ok: true,
      code: "idle",
      message: "",
      state: "idle",
      appName: "群岛插件：屏幕录制",
      appPath:
        "/Users/fixture/Applications/Mini Archipel Plugin - Screen Recorder.app",
    } as RecorderReply,
    error: null,
    permissions: { screen: permission(), input: permission() },
  };
  return {
    enable() {
      enabled = true;
    },
    reset() {
      enabled = false;
      data.recorder.state = "idle";
      data.permissions = { screen: permission(), input: permission() };
    },
    apply(snapshot: Snapshot) {
      if (enabled)
        snapshot.plugins["screen-recording"] = {
          version: 1,
          enabled: true,
          status: "ready",
          ts: Date.now(),
          data: structuredClone(data),
          error: null,
        };
    },
    action(action: string, body: unknown) {
      if (action === "doctor" || action === "pointer-doctor") {
        const key = action === "doctor" ? "screen" : "input";
        data.permissions[key] = {
          status: "verified",
          checked_at: Date.now(),
          requested_at: null,
          message: "Fixture capability checked",
        };
      }
      if (action === "authorize" || action === "pointer-authorize") {
        if (
          !body ||
          typeof body !== "object" ||
          !("interactive" in body) ||
          body.interactive !== true
        )
          throw Error("explicit request missing");
        const key = action === "authorize" ? "screen" : "input";
        data.permissions[key] = {
          status: "waiting",
          checked_at: Date.now(),
          requested_at: Date.now(),
          message: "Fixture waiting for node confirmation",
        };
      }
      if (action === "start")
        data.recorder = {
          ...data.recorder,
          state: "recording",
          code: "recording_started",
        };
      if (action === "stop")
        data.recorder = {
          ...data.recorder,
          state: "stopping",
          code: "stop_requested",
        };
      return {
        ...data.recorder,
        ...(action === "windows"
          ? {
              windows: [
                { id: 238, title: "Fixture editor", bundleID: "test.fixture" },
              ],
            }
          : {}),
      };
    },
  };
}
