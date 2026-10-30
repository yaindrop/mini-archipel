import { lazy } from "react";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { MonitorCog } from "lucide-react";
import type { WorkbenchPlugin } from "../../web/plugins.tsx";
import "./styles.css";

export const desktopAutomationWorkbench: WorkbenchPlugin = {
  id: "desktop-automation",
  get label() {
    return i18n._(msg`桌面自动化`);
  },
  to: "/desktop-automation",
  icon: MonitorCog,
  nodeOrder: 0,
  Page: lazy(async () => ({
    default: (await import("./workbench.tsx")).DesktopAutomation,
  })),
  NodePanel: lazy(async () => ({
    default: (await import("./workbench.tsx")).NodePanel,
  })),
};
