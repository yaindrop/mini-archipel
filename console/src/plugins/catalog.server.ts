import { runnersPlugin } from "./runners/server.ts";
import { fanControlPlugin } from "./fan-control/server.ts";
export const serverPlugins = [runnersPlugin, fanControlPlugin];
