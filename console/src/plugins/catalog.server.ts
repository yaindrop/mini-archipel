import { screenRecordingPlugin } from "../../../plugins/screen-recording/console/src/server.ts";
import { fanControlPlugin } from "../../../plugins/fan-control/console/src/server.ts";
import { proxyPlugin } from "../../../plugins/proxy/console/src/server.ts";
import { automationPlugin } from "../../../plugins/automation/console/src/server.ts";
import { runnersPlugin } from "../../../plugins/runners/console/src/server.ts";
import { registerPlugins } from "./manifest.ts";
export const serverPlugins = registerPlugins([
  screenRecordingPlugin,
  fanControlPlugin,
  proxyPlugin,
  automationPlugin,
  runnersPlugin,
]);
