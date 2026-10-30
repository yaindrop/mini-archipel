import { runnersWorkbench } from "./runners/web.tsx";
import { fanControlWorkbench } from "./fan-control/web.tsx";
import { miniProxyWorkbench } from "./mini-proxy/web.tsx";
export const workbenchPlugins = [
  runnersWorkbench,
  fanControlWorkbench,
  miniProxyWorkbench,
];
