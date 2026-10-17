import { lazy } from "react";
import { Terminal } from "lucide-react";
import type { WorkbenchPlugin } from "../../web/plugins.tsx";
import { runnersFor, remoteFor } from "./domain.ts";
import { RunnerSummary } from "./status.tsx";
import "./styles.css";

export const runnersWorkbench: WorkbenchPlugin = {
  id: "runners",
  label: "Runners",
  to: "/runners",
  icon: Terminal,
  badge: (fleet) =>
    fleet.hosts.reduce((sum, host) => sum + runnersFor(host).length, 0),
  Page: lazy(async () => ({
    default: (await import("./workbench.tsx")).Runners,
  })),
  OverviewPanel: lazy(async () => ({
    default: (await import("./workbench.tsx")).OverviewPanel,
  })),
  NodePanel: lazy(async () => ({
    default: (await import("./workbench.tsx")).NodePanel,
  })),
  ConnectionsPanel: lazy(async () => ({
    default: (await import("./workbench.tsx")).ConnectionsPanel,
  })),
  columns: ({ fleet, now }) => [
    {
      title: "Runner",
      key: "plugin-runners",
      responsive: ["md"],
      render: (_value, host) => {
        return (
          <RunnerSummary host={host} now={now} remote={remoteFor(fleet)} />
        );
      },
    },
  ],
};
