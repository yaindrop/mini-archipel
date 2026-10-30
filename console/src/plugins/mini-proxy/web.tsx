import { lazy } from "react";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Globe } from "lucide-react";
import type { WorkbenchPlugin } from "../../web/plugins.tsx";

export const miniProxyWorkbench: WorkbenchPlugin = {
  id: "mini-proxy",
  get label() {
    return i18n._(msg`代理出口`);
  },
  to: "/proxy",
  icon: Globe,
  nodeOrder: 200,
  Page: lazy(async () => ({
    default: (await import("./workbench.tsx")).MiniProxy,
  })),
};
