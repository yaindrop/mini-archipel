import { lazy } from "react";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Fan } from "lucide-react";
import type { WorkbenchPlugin } from "../../web/plugins.tsx";
import "./styles.css";
export const fanControlWorkbench: WorkbenchPlugin = {
  id: "fan-control",
  get label() {
    return i18n._(msg`风扇控制`);
  },
  to: "/fan-control",
  icon: Fan,
  nodeOrder: 0,
  Page: lazy(async () => ({
    default: (await import("./workbench.tsx")).FanControl,
  })),
  NodePanel: lazy(async () => ({
    default: (await import("./workbench.tsx")).NodePanel,
  })),
};
