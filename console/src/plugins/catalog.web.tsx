import { screenRecorderWorkbench } from "../../../plugins/screen-recording/console/src/web.tsx";
import { fanControlWorkbench } from "../../../plugins/fan-control/console/src/web.tsx";
import { miniProxyWorkbench } from "../../../plugins/proxy/console/src/web.tsx";
import { desktopAutomationWorkbench } from "../../../plugins/automation/console/src/web.tsx";
import { runnersWorkbench } from "../../../plugins/runners/console/src/web.tsx";
export const workbenchPlugins = [
  screenRecorderWorkbench,
  fanControlWorkbench,
  miniProxyWorkbench,
  desktopAutomationWorkbench,
  runnersWorkbench,
];
