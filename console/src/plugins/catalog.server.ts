import { runnersPlugin } from "./runners/server.ts";
import { fanControlPlugin } from "./fan-control/server.ts";
import { miniProxyPlugin } from "./mini-proxy/server.ts";
export const serverPlugins = [runnersPlugin, fanControlPlugin, miniProxyPlugin];
