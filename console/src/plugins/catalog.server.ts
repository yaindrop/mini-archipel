import { screenRecorderPlugin } from "../../../plugins/screen-recording/console/src/server.ts";
import { fanControlPlugin } from "../../../plugins/fan-control/console/src/server.ts";
import { miniProxyPlugin } from "../../../plugins/proxy/console/src/server.ts";
import { desktopAutomationPlugin } from "../../../plugins/automation/console/src/server.ts";
import { runnersPlugin } from "../../../plugins/runners/console/src/server.ts";
export const serverPlugins = [
  { ...screenRecorderPlugin, legacyIds: ["screen-recorder"] },
  fanControlPlugin,
  { ...miniProxyPlugin, legacyIds: ["mini-proxy"] },
  { ...desktopAutomationPlugin, legacyIds: ["desktop-automation"] },
  runnersPlugin,
];
