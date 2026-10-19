import { useLingui as useLinguiMacro } from "@lingui/react/macro";
import { useLingui } from "@lingui/react";
import {
  Component,
  createContext,
  useContext,
  type ComponentType,
  type ReactNode,
} from "react";
import { Link } from "react-router";
import { Alert, type TableColumnsType } from "antd";
import type { LucideIcon } from "lucide-react";
import type { Archipel, Host } from "../contracts.ts";
export interface WorkspaceProps {
  archipel: Archipel;
  now: number;
}
export interface WorkbenchPlugin {
  id: string;
  label: string;
  to: string;
  icon: LucideIcon;
  Page: ComponentType<WorkspaceProps>;
  badge?: (archipel: Archipel) => number;
  columns?: (props: WorkspaceProps) => TableColumnsType<Host>;
  OverviewPanel?: ComponentType<WorkspaceProps>;
  nodeOrder?: number;
  NodePanel?: ComponentType<
    WorkspaceProps & {
      host: Host;
    }
  >;
  ConnectionsPanel?: ComponentType<WorkspaceProps>;
}
const Catalog = createContext<WorkbenchPlugin[]>([]);
export function PluginProvider({
  plugins,
  children,
}: {
  plugins: WorkbenchPlugin[];
  children: ReactNode;
}) {
  useLingui();
  return <Catalog value={plugins}>{children}</Catalog>;
}
export function usePluginCatalog() {
  return useContext(Catalog);
}
export function useWorkbenchPlugins(archipel: Archipel | undefined) {
  return usePluginCatalog().filter(
    (plugin) => archipel?.plugins[plugin.id]?.enabled,
  );
}
export class PluginSlot extends Component<
  {
    label: string;
    children: ReactNode;
  },
  {
    failed: boolean;
  }
> {
  override state = {
    failed: false,
  };
  static getDerivedStateFromError() {
    return {
      failed: true,
    };
  }
  override render() {
    return this.state.failed ? (
      <PluginError label={this.props.label} />
    ) : (
      this.props.children
    );
  }
}
function PluginError({ label }: { label: string }) {
  const { t } = useLinguiMacro();
  return (
    <Alert
      showIcon
      type="error"
      title={t`${label} 插件暂时无法显示`}
      description={
        <Link to="/plugins">{t`检查插件设置；基础监控仍可使用。`}</Link>
      }
    />
  );
}
