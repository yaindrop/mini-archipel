import { fanControlWorkbench } from "./fan-control/web.tsx";
import { miniProxyWorkbench } from "./mini-proxy/web.tsx";
import { desktopAutomationWorkbench } from "./desktop-automation/web.tsx";
import { runnersWorkbench } from "./runners/web.tsx";
export const workbenchPlugins = [
  fanControlWorkbench,
  miniProxyWorkbench,
  desktopAutomationWorkbench,
  runnersWorkbench,
];
