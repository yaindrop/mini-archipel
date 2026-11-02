import { lazy } from "react";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Video } from "lucide-react";
import type { WorkbenchPlugin } from "../../../../console/src/web/plugins.tsx";
import "./styles.css";
export const screenRecordingWorkbench: WorkbenchPlugin = {
  id: "screen-recording",
  get label() {
    return i18n._(msg`屏幕录制`);
  },
  to: "/screen-recording",
  icon: Video,
  nodeOrder: 0,
  Page: lazy(async () => ({
    default: (await import("./workbench.tsx")).ScreenRecording,
  })),
  NodePanel: lazy(async () => ({
    default: (await import("./workbench.tsx")).NodePanel,
  })),
};
