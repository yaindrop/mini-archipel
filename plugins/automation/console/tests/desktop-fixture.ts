import type { DesktopData } from "../src/contracts.ts";

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
        accessibility_verified: true,
        automation_verified: true,
        app_name: "群岛插件：自动化",
        app_path: "/Applications/Mini Archipel Plugin - Automation.app",
        automation: true,
        checked_at: Date.now() / 1000,
        screen_locked: false,
        console_session: true,
      },
      jobs: [],
      paused: false,
      desktop_busy: false,
      capabilities: [
        "input",
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
