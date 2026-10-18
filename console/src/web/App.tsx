import { msg } from "@lingui/core/macro";
import { useLingui as useLinguiMacro } from "@lingui/react/macro";
import { remoteText } from "../messages.ts";
import { useLingui } from "@lingui/react";
import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { Link, Route, Routes, useLocation, useMatch } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App as AntApp,
  Avatar,
  Badge,
  Breadcrumb,
  Button,
  ConfigProvider,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Grid,
  Input,
  Layout,
  Menu,
  Result,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  theme,
  type ThemeConfig,
} from "antd";
import { Preferences, usePreferences } from "./preferences.tsx";
import enUS from "antd/locale/en_US";
import zhCN from "antd/locale/zh_CN";
import {
  Activity,
  ChartNoAxesCombined,
  CircleHelp,
  HardDrive,
  LayoutDashboard,
  LogOut,
  Menu as MenuIcon,
  Network,
  Pause,
  Play,
  Radio,
  Puzzle,
} from "lucide-react";
import type { Fleet } from "../contracts.ts";
import { displayName, nodeIdentityLabel, stale, timeLabel } from "../domain.ts";
import { api, message } from "./api.ts";
import { useFleet, withLivePlugins } from "./useFleet.ts";
import { Brand, HostIdentity, NodeStatus, PageTitle, Section } from "./ui.tsx";
import {
  PluginSlot,
  usePluginCatalog,
  useWorkbenchPlugins,
} from "./plugins.tsx";
const PluginSettings = lazy(async () => ({
  default: (await import("./plugin-settings.tsx")).PluginSettings,
}));
const Overview = lazy(async () => ({
  default: (await import("./overview.tsx")).Overview,
}));
const NodeDetail = lazy(async () => ({
  default: (await import("./node.tsx")).NodeDetail,
}));
const Storage = lazy(async () => ({
  default: (await import("./storage.tsx")).Storage,
}));
const History = lazy(async () => ({
  default: (await import("./history.tsx")).History,
}));
export class ErrorBoundary extends Component<
  {
    children: ReactNode;
  },
  {
    error: boolean;
  }
> {
  override state = {
    error: false,
  };
  static getDerivedStateFromError() {
    return {
      error: true,
    };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Workbench render failed", error.name, info.componentStack);
  }
  override render() {
    return this.state.error ? <ErrorScreen /> : this.props.children;
  }
}
function Login() {
  const { _ } = useLingui();
  const { t } = useLinguiMacro();
  const [form] = Form.useForm<{
      token: string;
    }>(),
    client = useQueryClient();
  const login = useMutation({
    mutationFn: ({ token }: { token: string }) => api.login(token),
    onSuccess: () => {
      form.resetFields();
      void client.invalidateQueries({
        queryKey: ["session"],
      });
    },
  });
  return (
    <main className="login-page">
      <div className="login-brand">
        <Brand />
        <div className="login-orbit" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <i />
        </div>
        <p>
          {t` 清楚看见每台节点。 `}
          <br />
          {t` 从资源状态，到每一次接单。 `}
        </p>
        <small>{t`Fleet operations`}</small>
      </div>
      <div className="login-form-panel">
        <div className="login-preferences">
          <Preferences />
        </div>
        <div className="login-content">
          <span className="eyebrow">{t`WELCOME BACK`}</span>
          <Typography.Title level={1}>{t`连接你的集群`}</Typography.Title>
          <Typography.Paragraph type="secondary">{t`输入工作台访问令牌，查看节点并执行运维操作。`}</Typography.Paragraph>
          <Form
            form={form}
            layout="vertical"
            requiredMark={false}
            onFinish={(values) => {
              login.mutate(values);
            }}
          >
            <Form.Item
              name="token"
              label={t`访问令牌`}
              rules={[
                {
                  required: true,
                  whitespace: true,
                  message: t`请输入访问令牌`,
                },
              ]}
              extra={t`令牌由集群管理员提供，仅用于建立当前会话。`}
            >
              <Input.Password
                autoComplete="current-password"
                placeholder={t`输入访问令牌`}
                size="large"
                visibilityToggle={false}
              />
            </Form.Item>
            {login.isError ? (
              <Alert
                type="error"
                showIcon
                title={message(login.error, _)}
                role="alert"
              />
            ) : null}
            <Button
              block
              type="primary"
              size="large"
              htmlType="submit"
              loading={login.isPending}
            >{t`进入工作台`}</Button>
          </Form>
          <div className="login-security">
            <Network size={14} />
            {t` 私有网络 · HttpOnly 会话 `}
          </div>
        </div>
      </div>
    </main>
  );
}
const NAV = [
  {
    to: "/",
    get label() {
      return msg`集群概览`;
    },
    icon: LayoutDashboard,
  },
  {
    to: "/storage",
    get label() {
      return msg`存储空间`;
    },
    icon: HardDrive,
  },
  {
    to: "/history",
    get label() {
      return msg`历史趋势`;
    },
    icon: ChartNoAxesCombined,
  },
  {
    to: "/plugins",
    get label() {
      return msg`插件管理`;
    },
    icon: Puzzle,
  },
];
function Connections({ fleet, now }: { fleet: Fleet; now: number }) {
  const { _ } = useLingui();
  const { t } = useLinguiMacro();
  const config = useQuery({
    queryKey: ["config"],
    queryFn: api.config,
  });
  const plugins = useWorkbenchPlugins(fleet);
  return (
    <>
      <PageTitle
        eyebrow={t`CONNECTIONS`}
        title={t`连接诊断`}
        description={t`检查节点采集通道与插件接入状态。`}
      />
      <div className="connections-grid">
        <Section title={t`节点连接`}>
          <div className="connection-list">
            {fleet.hosts.map((host, index) => (
              <div key={host.name}>
                <HostIdentity host={host} index={index} />
                <code>
                  {config.data?.hosts.find((h) => h.name === host.name)?.url ??
                    t`正在读取连接地址`}
                </code>
                <NodeStatus host={host} now={now} />
                {host.lastError ? (
                  <Alert
                    type="error"
                    title={remoteText(host.lastError, _)}
                    showIcon
                  />
                ) : null}
              </div>
            ))}
          </div>
          {config.isError ? (
            <Alert
              type="error"
              title={message(config.error, _)}
              showIcon
              role="alert"
            />
          ) : null}
        </Section>
        <div className="connections-aside">
          {plugins.map((plugin) =>
            plugin.ConnectionsPanel ? (
              <PluginSlot key={plugin.id} label={plugin.label}>
                <plugin.ConnectionsPanel fleet={fleet} now={now} />
              </PluginSlot>
            ) : null,
          )}
          <Section title={t`采集说明`}>
            <Descriptions
              column={1}
              size="small"
              items={[
                {
                  key: "version",
                  label: t`工作台版本`,
                  children: config.data?.version ?? "—",
                },
                {
                  key: "resources",
                  label: t`实时资源`,
                  children: t`每秒`,
                },
                {
                  key: "process",
                  label: t`活跃进程`,
                  children: t`2 秒`,
                },
                {
                  key: "scan",
                  label: t`目录扫描`,
                  children: t`6 小时或手动`,
                },
                {
                  key: "expiry",
                  label: t`失效判定`,
                  children: t`10 秒未更新`,
                },
              ]}
            />
          </Section>
        </div>
      </div>
    </>
  );
}
function Workbench() {
  const { _ } = useLingui();
  const { i18n, t } = useLinguiMacro();
  const [paused, setPaused] = useState(false),
    [frozen, setFrozen] = useState<Fleet | undefined>(undefined),
    [now, setNow] = useState(() => Date.now()),
    [mobile, setMobile] = useState(false);
  const screens = Grid.useBreakpoint(),
    compact = !screens.lg,
    feed = useFleet(paused),
    fleet = paused && frozen ? withLivePlugins(frozen, feed.data) : feed.data,
    location = useLocation(),
    nodeRoute = useMatch("/nodes/:name"),
    activeNode = fleet?.hosts.find(
      (host) => host.name === nodeRoute?.params.name,
    ),
    client = useQueryClient();
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    document.title = fleet
      ? t`群岛 · 节点工作台（${String(fleet.hosts.filter((h) => !stale(h, now)).length)}/${String(fleet.hosts.length)}）`
      : t`群岛 · 节点工作台`;
  }, [fleet, now, i18n.locale, t]);
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      client.removeQueries({
        queryKey: ["fleet"],
      });
      client.removeQueries({
        queryKey: ["history"],
      });
      client.setQueryData(["session"], {
        authenticated: false,
        required: true,
      });
    },
  });
  const plugins = useWorkbenchPlugins(fleet),
    catalog = usePluginCatalog();
  const navigationItems = [
    ...NAV.map((item) => ({
      ...item,
      label: _(item.label),
    })),
    ...plugins.map((plugin) => ({
      to: plugin.to,
      label: plugin.label,
      icon: plugin.icon,
    })),
  ];
  const page = nodeRoute
    ? activeNode
      ? displayName(activeNode)
      : t`节点不存在`
    : (navigationItems.find((n) =>
        n.to === "/"
          ? location.pathname === "/"
          : location.pathname.startsWith(n.to),
      )?.label ?? t`连接诊断`);
  const effectiveNow = paused && fleet ? fleet.ts : now;
  const menuItems = navigationItems.map((item) => ({
    key: item.to,
    icon: <item.icon size={18} />,
    label: (
      <Link
        to={item.to}
        onClick={() => {
          setMobile(false);
        }}
      >
        {item.label}
        {plugins.find((plugin) => plugin.to === item.to)?.badge ? (
          <Tag variant="filled">
            {fleet
              ? plugins.find((plugin) => plugin.to === item.to)?.badge?.(fleet)
              : 0}
          </Tag>
        ) : null}
      </Link>
    ),
  }));
  const selected = navigationItems.some((item) => item.to === location.pathname)
    ? location.pathname
    : location.pathname.startsWith("/nodes/")
      ? location.pathname
      : "/connections";
  const navigation = (
    <div className="sidebar-content">
      <Link
        to="/"
        className="brand-link"
        onClick={() => {
          setMobile(false);
        }}
      >
        <Brand />
      </Link>
      <div className="workspace-label">
        <Avatar shape="square">M</Avatar>
        <span>
          <strong>{t`我的集群`}</strong>
          <small>{t`私有工作空间`}</small>
        </span>
        <Tag variant="filled">{t`${fleet?.hosts.length ?? "—"} 节点`}</Tag>
      </div>
      <nav aria-label={t`主导航`}>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selected]}
          items={menuItems}
        />
      </nav>
      <div className="nav-caption">
        {t` 节点`}
        <span>{fleet?.hosts.length ?? 0}</span>
      </div>
      <nav className="node-navigation" aria-label={t`节点导航`}>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selected]}
          items={
            fleet?.hosts.map((h) => ({
              key: `/nodes/${encodeURIComponent(h.name)}`,
              icon: (
                <Badge status={stale(h, effectiveNow) ? "error" : "success"} />
              ),
              label: (
                <Link
                  to={`/nodes/${encodeURIComponent(h.name)}`}
                  onClick={() => {
                    setMobile(false);
                  }}
                >
                  <span>{displayName(h)}</span>
                  <small>{nodeIdentityLabel(h, _)}</small>
                </Link>
              ),
            })) ?? []
          }
        />
      </nav>
      <div className="sidebar-bottom">
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selected]}
          items={[
            {
              key: "/connections",
              icon: <Network size={17} />,
              label: (
                <Link
                  to="/connections"
                  onClick={() => {
                    setMobile(false);
                  }}
                >{t`连接诊断`}</Link>
              ),
            },
          ]}
        />
        <div className="sidebar-health">
          <Radio size={17} />
          <span>
            <strong>
              {paused
                ? t`更新已暂停`
                : feed.connection === "live"
                  ? t`实时采集已连接`
                  : feed.connection === "hidden"
                    ? t`后台待机`
                    : t`正在恢复连接`}
            </strong>
            <small>
              {fleet ? t`最近采集 ${timeLabel(fleet.ts)}` : t`正在等待节点上报`}
            </small>
          </span>
        </div>
        <div className="sidebar-version">
          {t` 群岛`}
          <span>v0.11.0</span>
        </div>
      </div>
    </div>
  );
  return (
    <Layout className="workbench">
      <a className="skip-link" href="#main-content">{t`跳到工作区`}</a>
      {compact ? (
        <Drawer
          open={mobile}
          placement="left"
          onClose={() => {
            setMobile(false);
          }}
          size={260}
          title={t`工作台导航`}
          closable={{
            "aria-label": t`关闭导航菜单`,
          }}
          className="navigation-drawer"
          styles={{
            body: {
              padding: 0,
              background: "#15243b",
            },
            header: {
              background: "#15243b",
              color: "#edf3f9",
            },
          }}
        >
          {navigation}
        </Drawer>
      ) : (
        <Layout.Sider
          width={224}
          className="sidebar"
          aria-label={t`工作台导航`}
        >
          {navigation}
        </Layout.Sider>
      )}
      <Layout className="workspace-shell">
        <Layout.Header className="topbar">
          <Space size={12}>
            {compact ? (
              <Button
                type="text"
                icon={<MenuIcon size={20} />}
                aria-label={t`打开导航菜单`}
                onClick={() => {
                  setMobile(true);
                }}
              />
            ) : null}
            <Breadcrumb
              items={[
                {
                  title: <Link to="/">{t`我的集群`}</Link>,
                },
                {
                  title: page,
                },
              ]}
              className="topbar-breadcrumb"
              aria-label={t`工作区位置`}
            />
          </Space>
          <fieldset className="topbar-live" aria-label={t`实时监测控制`}>
            <Badge
              status={
                paused
                  ? "warning"
                  : feed.connection === "live"
                    ? "success"
                    : "processing"
              }
              text={
                paused
                  ? t`已暂停`
                  : feed.connection === "live"
                    ? t`实时更新`
                    : feed.connection === "hidden"
                      ? t`后台待机`
                      : t`轮询 / 重连`
              }
            />
            <time className="topbar-time">
              {new Date(now).toLocaleTimeString(i18n.locale, {
                hour12: false,
              })}
            </time>
            <Tooltip title={paused ? t`恢复实时更新` : t`暂停实时更新`}>
              <Button
                type="text"
                icon={paused ? <Play size={17} /> : <Pause size={17} />}
                aria-label={paused ? t`恢复实时更新` : t`暂停实时更新`}
                onClick={() => {
                  setFrozen(feed.data);
                  setPaused(!paused);
                }}
              />
            </Tooltip>
          </fieldset>
          <Space size={4} className="topbar-actions">
            <Preferences />
            <Tooltip title={t`退出工作台`}>
              <Button
                type="text"
                icon={<LogOut size={17} />}
                aria-label={t`退出工作台`}
                loading={logout.isPending}
                onClick={() => {
                  logout.mutate();
                }}
              />
            </Tooltip>
          </Space>
        </Layout.Header>
        <Layout.Content
          id="main-content"
          className="main-content"
          tabIndex={-1}
        >
          {paused ? (
            <Alert
              type="warning"
              showIcon
              title={t`实时更新已暂停，当前显示 ${
                fleet
                  ? new Date(fleet.ts).toLocaleTimeString(i18n.locale, {
                      hour12: false,
                    })
                  : t`最后一次`
              } 的采集结果。恢复更新后可获取最新状态。`}
              role="status"
            />
          ) : null}
          {fleet?.historyError && (
            <Alert
              type="warning"
              showIcon
              title={remoteText(fleet.historyError, _)}
              description={
                fleet.historyDropped
                  ? t`${String(fleet.historyDropped)} 个历史样本未保存，实时监测仍在运行。`
                  : undefined
              }
            />
          )}
          {feed.error ? (
            <Alert
              type="error"
              showIcon
              title={t`${message(feed.error, _)}。正在尝试重新连接。`}
              role="alert"
            />
          ) : null}
          {fleet
            ? Object.values(fleet.plugins)
                .filter((plugin) => plugin.enabled && plugin.error)
                .map((plugin) => (
                  <Alert
                    key={plugin.id}
                    type="warning"
                    showIcon
                    title={`${plugin.label}: ${plugin.error ? remoteText(plugin.error, _) : t`插件异常`}`}
                    action={<Link to="/plugins">{t`管理插件`}</Link>}
                  />
                ))
            : null}
          {logout.isError ? (
            <Alert
              type="error"
              showIcon
              title={message(logout.error, _)}
              role="alert"
            />
          ) : null}
          {fleet ? (
            <Suspense
              fallback={
                <div className="connection-loading" role="status">
                  <Spin size="large" />
                  <span>{t`正在加载工作区`}</span>
                </div>
              }
            >
              <Routes>
                <Route
                  path="/"
                  element={<Overview fleet={fleet} now={effectiveNow} />}
                />
                <Route
                  path="/nodes/:name"
                  element={<NodeDetail fleet={fleet} now={effectiveNow} />}
                />
                <Route
                  path="/plugins"
                  element={<PluginSettings fleet={fleet} now={effectiveNow} />}
                />
                {catalog.map((plugin) => (
                  <Route
                    key={plugin.id}
                    path={plugin.to}
                    element={
                      fleet.plugins[plugin.id]?.enabled ? (
                        <PluginSlot label={plugin.label}>
                          <plugin.Page fleet={fleet} now={effectiveNow} />
                        </PluginSlot>
                      ) : (
                        <Result
                          status="403"
                          title={t`插件未启用`}
                          subTitle={t`此功能由可选插件提供。`}
                          extra={<Link to="/plugins">{t`管理插件`}</Link>}
                        />
                      )
                    }
                  />
                ))}
                <Route
                  path="/storage"
                  element={<Storage fleet={fleet} now={effectiveNow} />}
                />
                <Route
                  path="/history"
                  element={
                    <History fleet={fleet} paused={paused} now={effectiveNow} />
                  }
                />
                <Route
                  path="/connections"
                  element={<Connections fleet={fleet} now={effectiveNow} />}
                />
                <Route
                  path="*"
                  element={
                    <Empty
                      description={
                        <span>
                          {t` 页面不存在，`}
                          <Link to="/">{t`返回集群概览`}</Link>
                        </span>
                      }
                    />
                  }
                />
              </Routes>
            </Suspense>
          ) : (
            <div className="connection-loading" role="status">
              <Spin size="large" />
              <span>{t`正在连接集群`}</span>
            </div>
          )}
          <footer className="workspace-footer">
            <span>
              <Activity size={12} />
              {t` 数据来自节点实际采集 `}
            </span>
            <Link to="/connections">
              <CircleHelp size={13} />
              {t` 采集与连接 `}
            </Link>
          </footer>
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
function SessionGate() {
  const { _ } = useLingui();
  const { t } = useLinguiMacro();
  const session = useQuery({
    queryKey: ["session"],
    queryFn: api.session,
    retry: 1,
    refetchOnWindowFocus: true,
  });
  if (session.isPending)
    return (
      <div className="connection-loading" role="status">
        <Spin size="large" />
        <span>{t`正在连接集群`}</span>
      </div>
    );
  if (session.isError)
    return (
      <main className="fatal-error">
        <Brand />
        <Result
          status="warning"
          title={<h1>{t`无法连接工作台`}</h1>}
          subTitle={message(session.error, _)}
          extra={
            <Button
              type="primary"
              onClick={() => {
                void session.refetch();
              }}
            >{t`重试连接`}</Button>
          }
        />
      </main>
    );
  return session.data.authenticated ? <Workbench /> : <Login />;
}
export function App() {
  useLingui();
  const { dark, locale } = usePreferences();
  const [reduced, setReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)"),
      change = () => {
        setReduced(media.matches);
      };
    media.addEventListener("change", change);
    return () => {
      media.removeEventListener("change", change);
    };
  }, []);
  const config: ThemeConfig = {
    cssVar: {
      key: "mini-archipel",
    },
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: dark ? "#75d6cc" : "#08727e",
      colorInfo: dark ? "#75d6cc" : "#08727e",
      colorSuccess: dark ? "#76c6a2" : "#207453",
      colorWarning: dark ? "#e7bc71" : "#95620f",
      colorError: dark ? "#efa096" : "#b3423a",
      colorText: dark ? "#e2eaf5" : "#23344a",
      colorTextSecondary: dark ? "#acbdd0" : "#5c6c80",
      colorTextTertiary: dark ? "#acbdd0" : "#5c6c80",
      colorTextDescription: dark ? "#acbdd0" : "#5c6c80",
      colorTextPlaceholder: dark ? "#acbdd0" : "#5c6c80",
      colorSuccessBg: dark ? "#203e36" : "#eaf6ef",
      colorSuccessBorder: dark ? "#3c705b" : "#c8e2d4",
      colorSuccessText: dark ? "#85d8af" : "#207453",
      colorInfoBg: dark ? "#233e49" : "#eaf6f5",
      colorInfoBorder: dark ? "#3c6777" : "#b8d9df",
      colorInfoText: dark ? "#83d9d2" : "#08727e",
      colorWarningBg: dark ? "#403625" : "#fff5e3",
      colorWarningText: dark ? "#e7bc71" : "#95620f",
      colorErrorBg: dark ? "#442d30" : "#fcefeb",
      colorErrorText: dark ? "#efa096" : "#b3423a",
      colorBgLayout: dark ? "#142133" : "#f3f6fa",
      colorBgContainer: dark ? "#1c2d42" : "#ffffff",
      colorBorderSecondary: dark ? "#35465c" : "#e1e8f0",
      fontFamily:
        'Manrope, -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
      fontFamilyCode: '"IBM Plex Mono", "SFMono-Regular", Consolas, monospace',
      fontSize: 13,
      borderRadius: 8,
      controlHeight: 36,
      motion: !reduced,
    },
    components: {
      Button: {
        primaryColor: dark ? "#142133" : "#ffffff",
        dangerColor: dark ? "#142133" : "#ffffff",
      },
      Layout: {
        headerBg: dark ? "#1c2d42" : "#ffffff",
        siderBg: "#15243b",
      },
      Menu: {
        darkItemBg: "#15243b",
        darkSubMenuItemBg: "#15243b",
        darkItemSelectedBg: "#25424d",
        darkItemSelectedColor: "#97e4d9",
        darkItemColor: "#b9c8da",
        itemHeight: 42,
        itemBorderRadius: 6,
      },
      Card: {
        headerFontSize: 14,
        bodyPadding: 20,
        headerPadding: 20,
      },
      Table: {
        headerBg: dark ? "#24364d" : "#f8fafc",
        cellPaddingBlock: 14,
        cellPaddingInline: 18,
      },
      Typography: {
        titleMarginTop: 0,
        titleMarginBottom: 8,
      },
      Tag: {
        fontSizeSM: 12,
        colorSuccess: dark ? "#85d8af" : "#207453",
        colorInfo: dark ? "#83d9d2" : "#08727e",
        colorWarning: dark ? "#e7bc71" : "#95620f",
        colorError: dark ? "#efa096" : "#b3423a",
      },
      Tabs: {
        horizontalMargin: "0 0 22px 0",
      },
    },
  };
  return (
    <ConfigProvider
      locale={locale === "zh" ? zhCN : enUS}
      getPopupContainer={(trigger) => trigger?.parentElement ?? document.body}
      theme={config}
      button={{
        autoInsertSpace: false,
      }}
    >
      <AntApp className="fleet-root">
        <ErrorBoundary>
          <SessionGate />
        </ErrorBoundary>
      </AntApp>
    </ConfigProvider>
  );
}
function ErrorScreen() {
  const { t } = useLinguiMacro();
  return (
    <main className="fatal-error">
      <Brand />
      <Result
        status="error"
        title={<h1>{t`工作台暂时无法显示`}</h1>}
        subTitle={t`请重新加载。节点上的任务不受影响。`}
        extra={
          <Button
            type="primary"
            onClick={() => {
              location.reload();
            }}
          >{t`重新加载`}</Button>
        }
      />
    </main>
  );
}
