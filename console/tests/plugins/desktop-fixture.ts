import type { DesktopData } from "../../src/plugins/desktop-automation/contracts.ts";

export function desktopFixture(): DesktopData {
  return {
    availability: "ready",
    control_allowed: true,
    scripts_allowed: true,
    interval_ms: 2000,
    error: null,
    toolkit: {
      version: 1,
      installed: true,
      apps: { codex: true, zcode: true },
      permissions: {
        accessibility: true,
        automation: true,
        checked_at: Date.now() / 1000,
        screen_locked: false,
        console_session: true,
      },
      jobs: [],
      paused: false,
      desktop_busy: false,
      capabilities: [
        "doctor",
        "permissions",
        "chat",
        "script",
        "get",
        "cancel",
        "coordinate",
        "diagnostics",
      ],
    },
  };
}
