import { lazy } from "react";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { MonitorCog } from "lucide-react";
import type { WorkbenchPlugin } from "../../../../console/src/web/plugins.tsx";
import "./styles.css";

export const automationWorkbench: WorkbenchPlugin = {
  id: "automation",
  get label() {
    return i18n._(msg`桌面自动化`);
  },
  to: "/automation",
  icon: MonitorCog,
  nodeOrder: 0,
  Page: lazy(async () => ({
    default: (await import("./workbench.tsx")).Automation,
  })),
  NodePanel: lazy(async () => ({
    default: (await import("./workbench.tsx")).NodePanel,
  })),
};
