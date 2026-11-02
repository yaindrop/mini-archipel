import { screenRecordingWorkbench } from "../../../plugins/screen-recording/console/src/web.tsx";
import { fanControlWorkbench } from "../../../plugins/fan-control/console/src/web.tsx";
import { proxyWorkbench } from "../../../plugins/proxy/console/src/web.tsx";
import { automationWorkbench } from "../../../plugins/automation/console/src/web.tsx";
import { runnersWorkbench } from "../../../plugins/runners/console/src/web.tsx";
export const workbenchPlugins = [
  screenRecordingWorkbench,
  fanControlWorkbench,
  proxyWorkbench,
  automationWorkbench,
  runnersWorkbench,
];
