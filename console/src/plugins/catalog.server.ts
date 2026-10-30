import { fanControlPlugin } from "./fan-control/server.ts";
import { miniProxyPlugin } from "./mini-proxy/server.ts";
import { desktopAutomationPlugin } from "./desktop-automation/server.ts";
import { runnersPlugin } from "./runners/server.ts";
export const serverPlugins = [
  fanControlPlugin,
  miniProxyPlugin,
  desktopAutomationPlugin,
  runnersPlugin,
];
