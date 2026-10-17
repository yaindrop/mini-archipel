# Console 工程说明

## 设计取舍

这是一套四节点运维工具。界面先回答「哪台机器有问题、当前能否接单」，再进入单机资源、进程和存储。概览首屏优先节点比较，详细指标留在节点页。桌面用表格对齐读数，手机将同一组节点数据变为卡片。实体机和虚拟机共用数据结构，按采集能力显示传感器。macmon 的 `all_power` 按芯片功耗标示，避免误称插座端整机功耗（[上游字段说明](https://github.com/vladkens/macmon/blob/main/readme.md)）。

产品名为“群岛 · 节点工作台”，favicon 直接使用四个方块的透明 SVG。节点页与所有标签内容共享同一个固定上限的满宽布局，目录只用树形展开，叶子不显示展开按钮；节点存储卡片整个可点击，支持键盘选择。布局和资源条不做宽度过渡，运维确认弹窗取消缩放过渡，避免 WebKit 快速点击落空。

视觉采用深蓝导航、浅灰画布、白色内容面板与青色操作色；数字用 IBM Plex Mono，界面用 Manrope 和系统中文字形，字体随产物自托管。Ant Design ConfigProvider 统一控制浅色 / 深色主题、状态色、控件密度与减少动画偏好，主题 Token 通过 CSS 变量同时供业务图表和布局使用。

通用界面统一使用 Ant Design 6.6.6：Layout / Menu / Drawer、Form / Input / Select、Table、Tabs / Segmented、Modal、Alert / Message、Tag / Badge、Card / Statistic、Descriptions / Breadcrumb、Progress / Empty / Result / Spin。`ui.tsx` 仅组织品牌、节点身份、业务状态和指标卡；业务图表保留 SVG 实现。ESLint 限制直接使用原生通用控件，防止重新出现第二套组件实现。

Runner 的采集、数据模型、GitHub 集成、控制和工作台扩展已迁到内置插件；核心通过通用接口调度。生命周期、信封和配置见 [插件系统](../docs/plugins.md)。

数据层仍使用 React Query、Zod、Fastify 与 SQLite。参考 video-workbench 的工程门禁和分区思路维护本项目的模块边界。

## 模块边界

| 文件                  | 责任                                                                      |
| --------------------- | ------------------------------------------------------------------------- |
| `src/contracts.ts`    | Zod 校验 agent、HTTP、WebSocket 与历史数据，导出共享 TS 类型              |
| `src/domain.ts`       | 单位、状态、过期判定、告警、存储树与指标口径                              |
| `src/fleet.ts`        | 基础采集、同节点轮询去重、最近走势                                        |
| `src/store.ts`        | SQLite 写入、分层聚合、保留与有界查询                                     |
| `src/app.ts`          | 可注入 transport 的 Fastify 应用、会话、输入校验、操作保护、静态资源与 WS |
| `src/server.ts`       | 配置、监听、退出与运行目录                                                |
| `src/web/App.tsx`     | 登录、导航、布局、错误边界及页面路由                                      |
| `src/web/useFleet.ts` | React Query 缓存、WS、重连、轮询、可见性与暂停                            |
| `src/plugins/*`       | 插件运行时、契约和注册表；具体插件独立拥有业务、校验与 UI                 |
| `src/web/plugins.tsx` | 工作台通用扩展接口和局部错误隔离                                          |
| `src/web/*`           | 概览、节点、存储、历史及共用 UI / SVG 图表                                |

服务端和浏览器共用运行时校验，网络返回值先作为 unknown。缺少数据用空态，旧快照保留但明确标记过期。服务端不把 agent 异常、凭据或 curl 原始错误直接反射给浏览器。

## 版本与工具链

2026-10-17 对照官方发布说明和 npm registry 选择并锁定依赖：React 19.3.1、React Compiler 1.0、Ant Design 6.6.6、Vite 8.3.4、TypeScript 7.0.2、React Router 8、TanStack Query 5、Fastify 5、Zod 4。Node 支持 24.12+（24.x）与 26.x，CI 覆盖 24 / 26；部署用固定路径的 Node。

TypeScript 7 原生编译器通过 `@typescript/native` npm alias 安装，`typecheck` 显式调用其入口。带类型的 ESLint 当前仍需要 TypeScript 6 的 JS API，因此 `typescript@6.0.3` 单独保留给分析工具，不依赖不确定的 `tsc` bin 覆盖顺序。

官方依据：

- [Ant Design 主题与组件 Token](https://ant.design/docs/react/customize-theme/)、[Table](https://ant.design/components/table/)、[App 上下文](https://ant.design/components/app/)
- [React 19.3](https://react.dev/blog/2026/09/09/react-19-3)
- [React Compiler 安装](https://react.dev/learn/react-compiler/installation)
- [Vite 8](https://vite.dev/blog/announcing-vite8)
- [TypeScript 7 与工具 API 兼容](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
- [typescript-eslint 带类型的 lint](https://typescript-eslint.io/getting-started/typed-linting/)
- [checkout](https://github.com/actions/checkout/releases/tag/v7.0.1)、[setup-node](https://github.com/actions/setup-node/releases/tag/v7.1.0)、[upload-artifact](https://github.com/actions/upload-artifact/releases/tag/v7.0.2)：CI 使用固定 commit SHA。

静态检查各负其责：TS 严格类型；ESLint 10 检查带类型的逻辑和 Hooks / Compiler；Biome 检查 JSX 无障碍与 CSS 正确性；Prettier 统一格式；Knip 查闲置依赖及导出。规则不为通过检查而整段关闭。外部数据边界使用 Zod。

## 验证

```sh
npm ci
npm run check
npm run check:agent
npx playwright install chromium webkit
npm run test:browser
npm run audit
```

- Vitest：状态与格式、存储分类、SQLite 聚合 / 保留 / 回滚、配置、真实本地 HTTP curl transport、会话与跨站拦截、Runner 忙碌保护、上游错误、WebSocket 和关键 UI。
- 覆盖率门槛：核心模块语句 / 行 80%、分支 75%、函数 80%。
- Playwright：同一个生产构建、真实 HTTP / WS 边界，Chromium、WebKit、手机视口；筛选与深链接、进程搜索、Runner 确认与取消 / 重启、扫描回执、CSV、离线恢复、暂停、主题及登录退出；补充排序方向 / URL 恢复、异步操作期间的弹窗保护、服务端拒绝后的错误反馈，以及 1280×720 下四节点首屏可见。
- axe：七个主要页面的浅色 / 深色主题、确认弹窗和 Select 浮层，执行 WCAG A / AA、2.1 / 2.2 AA 与 best-practice 自动检查；同时检查页面不会产生横向整体溢出。扫描等待真实的有限动画结束，避免把淡入中的半透明颜色当作最终对比度，不跳过规则。
- 测试 fixture 使用四台模拟节点和临时 SQLite，所有启停测试只作用于 fixture，不操作真实 CI Runner。

自动扫描不能替代人工无障碍审查。浏览器截图用于人工检查层级、间距、表格与手机可读性，不采用随指标每秒变化的逐像素快照门禁。

## 发布与兼容

Vite 按业务路由、共享表格与 React 运行时拆分前端并对资产加内容哈希，所有 JS 分块低于 500 kB 的默认警戒线。esbuild 将服务端打成 `dist/server.cjs`。安装器复制整个 web 目录；HTML 不缓存，哈希资源长期缓存。配置和 SQLite 保存在发布目录之外，现有主机历史键保持不变；0.6 的命名迁移路径见 README。

原来的 `?token=` 链接和 localStorage token 认证已移除。首次打开登录页输入原 `uiToken`，换取 HttpOnly 会话；令牌不出现在 URL。过期会话会停止实时订阅并回到登录。GitHub Token 是可选服务端配置，不依赖开发者机器的 gh 登录。

安装器保存旧程序与旧 plist，启动健康检查失败时回滚。真实部署验收只检查页面 / 静态资源 / 认证 / 四节点采集 / 历史 / WS，不启停真实 Runner。

## 0.6：mini-archipel、国际化与外观

采用 Lingui 6.10.0 的 PO 消息目录、ICU 变量和复数、生产编译及 `check sync` / `check missing --mode catalog`。React 组件使用 `useLingui` 宏返回的响应式 `t`；模块级静态文案保存为消息描述符，到渲染时翻译。共享展示函数接收上下文翻译函数，避免 React Compiler 缓存全局可变语言状态。服务端消息在各自源文件（包括插件）标记，展示时翻译，不为翻译把插件行为写入核心。

Vite 保留 React Compiler；Lingui Babel preset 在 Compiler 前执行。Vitest 使用 Lingui 原生宏变换。ESLint 防止未标记中文文案、错误嵌套翻译；语言名称保留原生写法。系统偏好用 `useSyncExternalStore` 订阅，跟踪媒体查询、浏览器语言和跨标签页存储事件。外部首屏脚本与 CSP `script-src self` 兼容，不需要放开内联脚本。

主题使用 Ant Design `defaultAlgorithm` / `darkAlgorithm` 和统一设计 Token；图表、目录条、弹窗及页面沿用同一组配色。语言切换不重挂载页面、不清空输入、不清空查询缓存，主题切换不重启动画布局。

依赖审计：生产依赖无已知高危 / 严重漏洞。Lingui CLI 与 ESLint 的开发依赖链引入 braces 3.0.3，存在尚无修复版本的 [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)。这里只处理仓库维护的 glob，不处理浏览器输入。`npm run audit` 完整审计，仅允许这一条且必须全部属于开发依赖；新增高危 / 严重公告、生产依赖或审计失败会使检查失败。不是“0 漏洞”的全量审计结果。

参考：[Lingui 安装与 React Compiler](https://lingui.dev/installation)、[惰性翻译](https://lingui.dev/guides/lazy-translations)、[消息提取](https://lingui.dev/guides/message-extraction)、[CLI 校验](https://lingui.dev/ref/cli)、[Ant Design 主题](https://ant.design/docs/react/customize-theme/)。

### 完整本地验收 · 2026-10-17

- 从 lockfile 干净安装；安装脚本仅批准锁定版本的 esbuild，明确拒绝可选 fsevents 的脚本。npm 支持 `allowScripts` 时执行此许可表。
- Node 24.21.0 / 26.12.0 分别通过全部质量门禁：消息同步与完整性、严格类型、ESLint、Biome、Prettier、Knip、81 项单元 / 接口测试、覆盖率及生产构建。Lingui 严格目录编译通过。
- 两种 Node 环境分别通过 Chromium、WebKit、手机视口的 90 项浏览器测试，共 180 项；包含全部主要页面的浅色 / 深色 axe 检查、中英切换、系统偏好、Repo 隔离与忙碌保护。
- 覆盖率：语句 89.50%、分支 84.41%、函数 84.56%、行 89.91%，均超过门槛。两种 Node 环境生成的 52 个发布文件逐一 SHA-256 相同。
- Rust 格式、Clippy（警告即失败）、6 项单元测试、release 构建，以及真实 Agent HTTP 插件生命周期 / 持久化检查通过。
- 人工复核中英、浅色 / 深色、桌面和手机布局；存储色条保持精确比例，键盘 / 触控通过分类按钮操作，悬浮双向联动。截图等待浮层和有限动画完成。悬浮位移断言使用页面坐标，避免手机自动滚动造成假失败。
- 依赖审计使用上述明确、仅限开发依赖的单项豁免；校验会递归检查依赖链，未知引用、循环、空证据、生产依赖或其他高危 / 严重公告均失败。生产依赖 0 高危 / 严重漏洞。
- 三个仓库的本地文档链接、Shell 语法、凭据扫描通过；mini-fan-control 全部校验和与 arm64 编译通过。

四台 Agent 0.4.0 同一 SHA-256，Console 0.6.0；旧服务已卸载，新服务、两条宿主机隧道及两台物理机防火墙规则均使用新路径。真实 Runner.Listener PID 保持 61511 / 83147 / 554 / 554。SQLite 完整性、历史稳定键及部署文件清单按生产验收复核。物理机遗留安装源目录也统一为新名称，重新扫描确认当前目录中无旧名称。真实 CI 作业未作为测试对象启停。

本地验收与 GitHub Actions 是两组结果；推送后云端检查单独报告，不将已配置或已触发的 CI 当作通过。
