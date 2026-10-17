# mini-archipel · 群岛 · 节点工作台

群岛是物理机与虚拟机集群的节点工作台。集中查看资源、活跃进程、存储目录、历史趋势及 GitHub Actions Runner。

| 组件    | 技术                                                      | 部署位置                          |
| ------- | --------------------------------------------------------- | --------------------------------- |
| agent   | Rust · axum · sysinfo · macmon                            | 每台实体机 / VM，用户 LaunchAgent |
| console | TypeScript · React · Ant Design · Vite · Fastify · SQLite | yd-mini，浏览器访问               |
| VM 连接 | 独立 SSH 隧道 LaunchAgent                                 | Tart 宿主 MacBook                 |

项目、仓库、本地目录与监控服务统一使用 `mini-archipel`。中文名称为“群岛 · 节点工作台”，英文为“Mini Archipel · Node workbench”。

装机规范见 [mini-provisioning](https://github.com/yaindrop/mini-provisioning)，风扇服务见 [mini-fan-control](https://github.com/yaindrop/mini-fan-control)。

## 工作台

通用界面使用 Ant Design 6，主题由 ConfigProvider 统一管理。节点指标和监控图表按业务设计，页面按路由加载。

- **集群概览**：四台节点横向比较、在线与过期状态、CPU 加权占用、Runner 作业、磁盘余量和散热提醒。搜索、类型筛选及排序保存在 URL 中。
- **节点详情**：资源走势、逐核占用、内存口径、GPU / 功耗 / 温度 / 风扇、进程搜索。虚拟机按实际能力展示，缺失的硬件传感器不显示为零。
- **Runners**：按 Repo 管理其在各节点上的监听进程、Worker、工作目录与日志占用；节点可安装多个 Repo 的 Runner。启停前确认、服务端重新检查忙碌状态、操作反馈及异常处理。GitHub 未接入时明确只展示本地状态。
- **存储空间**：卷余量、目录分类、目录树展开、手动扫描。扫描是异步任务；目录扫描结果和 APFS 卷余量分别展示，父子目录不重复汇总。
- **历史趋势**：多节点比较、指标和时间窗口切换、悬停读数、CSV 导出。缺测时不连成连续曲线。
- **连接诊断**：节点端点、采集异常与 GitHub 接入状态。
- **交互**：桌面比较表、手机节点卡片、键盘导航与 `/` 搜索、语言与主题均默认跟随系统，支持中文 / English、浅色 / 深色手动选择；暂停更新、后台待机、断线轮询与自动重连。

页面路径为 `/`、`/nodes/:name`、`/runners`、`/storage`、`/history`、`/connections`、`/plugins`，可以收藏和直接打开。

## 架构

```text
浏览器 ── HTTP / WebSocket ── console :9100
                                │ SQLite 历史
                                │ curl + Bearer token，每秒轮询
                    ┌───────────┼─────────────────────┐
                    │           │                     │
              agent yd-mini  agent yd-mini-2    MacBook :9102 / :9103
                    :9101       :9101                 │ SSH 转发
                                               两台 Tart agent :9101
```

原始数据保留 24 小时，10 秒聚合保留 30 天，1 分钟聚合保留一年。查询合并各层并限制返回点数；工作台重启后从 SQLite 恢复最近走势。

Agent 核心采集 CPU、内存、swap、卷空间、Top 15 进程、热状态、风扇及目录树；Runner 的采集和服务控制由可选插件提供。macmon / fanctl 缺席时省略对应段。物理传感器由实体机上报，VM 的散热由宿主机负责。

## 本地开发与验证

需要 Node 24.12+（24.x）或 26.x，推荐使用 `.node-version` 固定的 Node 26。项目使用 npm 和已提交的 lockfile。

```sh
cd console
npm ci
npm run check
npm run check:agent
npx playwright install chromium webkit
npm run test:browser
```

`check` 包含 TypeScript 严格类型检查、带类型的 ESLint、React Hooks / Compiler 规则、Biome 无障碍与 CSS 检查、Prettier、Knip、带覆盖率门槛的单元 / 接口测试，以及生产构建。浏览器测试覆盖 Chromium、WebKit 和手机视口，并执行七个主要页面的 axe 无障碍检查。

开发时先准备本地配置（不要提交凭据），开两个终端：

```sh
# 终端一：配置 bind 为 127.0.0.1:19100
ARCHIPEL_WEB_DIR=dist/web npm run dev:server -- .preview/config.json
# 终端二：Vite 热更新，API / WS 转发到 19100
npm run dev
```

单独命令：`i18n:extract`、`i18n:check`、`audit`、`typecheck`、`lint`、`lint:ui`、`format:check`、`deadcode`、`test:coverage`、`test:browser`、`build`。CI 在 Node 24 / 26 上执行同样的门禁、依赖审计和浏览器测试。实现边界与版本依据见 [console/ENGINEERING.md](console/ENGINEERING.md)。

`PR Quality` 与 Flowbit 一样，只在明确给本仓库 PR 添加 `run-ci` 标签后运行，
作业开始后消费标签；再次添加可复跑。push、创建/更新 PR 与定时事件不运行质量检查。
更新 PR 后需重新请求，结果对应请求时的不可变 merge commit。仅接受本仓库 PR。
Agent 不主动加标签或调用 CI，除非人明确要求验证。

```sh
gh pr edit <PR编号> --repo yaindrop/mini-archipel --add-label run-ci
```

四节点各有 `~/github-runners/mini-archipel`，与 Flowbit、Flowbit Knowledge、In Frames
的独立 Runner 共享每节点一个作业的保护。四仓库共 16 个实例均由 Runner 插件按 Repo
发现与管理。共享脚本与部署规则见 [mini-provisioning](https://github.com/yaindrop/mini-provisioning/blob/main/docs/08-github-runner.md)。

## 部署

Agent（每台节点）：

```sh
./agent/build.sh
./agent/install.sh
```

Console 在构建机器完成全部检查后，将 `console/dist` 和 `console/install.sh` 一起复制到目标 Mac 的同一目录，再执行：

```sh
NODE_BIN=/opt/homebrew/bin/node ./install.sh
```

安装器第一次运行时生成权限为 600 的配置，填好节点令牌后再运行。更新会替换整个构建产物，包括带内容哈希的前端资源；保留上一版程序与 LaunchAgent，启动或健康检查失败时自动恢复。配置与 SQLite 在发布目录之外，更新不清空历史。

- 配置：`~/.config/mini-archipel/console.json`
- 程序：`~/.local/libexec/mini-archipel-console`
- 上一版：`~/.local/libexec/mini-archipel-console.previous`
- 数据库：配置中的 `dbPath`
- 日志：`~/Library/Logs/MiniArchipel/console.log`
- 服务：`local.miniarchipel.console`

访问 `http://yd-mini.local:9100/`，在登录页输入配置中的 `uiToken`。令牌不放在 URL，也不写入浏览器 localStorage。旧版令牌链接需要改为普通地址；首次使用新版需登录一次。

VM 隧道在宿主机上分别由 `local.miniarchipel.tunnel.yd-mbp-tart` 和 `local.miniarchipel.tunnel.yd-mbp-tart-2` 管理，使用 SSH 密钥认证和连接保活。宿主机转发端口须能被 console 所在主机访问。

## 插件

Runner 是可独立启停的内置插件，采集、GitHub 集成、服务控制、页面、导航和概览列均由插件注册。工作台的“插件管理”分别控制控制台与每台节点；关闭插件不会停止 CI 服务或 Worker。完整协议、扩展接口、配置和验收方法见 [插件系统](docs/plugins.md)。

## 配置

`~/.config/mini-archipel/console.json`（600）：

```json
{
  "bind": "0.0.0.0:9100",
  "uiToken": "<console access token>",
  "dbPath": "~/.local/share/mini-archipel/console.db",
  "plugins": { "runners": { "enabled": true, "options": {} } },
  "hosts": [
    {
      "name": "yd-mini",
      "kind": "physical",
      "identity": "M6 Mac Mini",
      "url": "http://127.0.0.1:9101",
      "token": "<agent token>"
    },
    {
      "name": "yd-mini-2",
      "kind": "physical",
      "identity": "M6 Mac Mini",
      "url": "http://<mini-2-ipv4>:9101",
      "token": "<agent token>"
    },
    {
      "name": "yd-mbp-tart",
      "kind": "virtual",
      "identity": "Tart on M4 Max MacBook",
      "url": "http://<macbook-ipv4>:9102",
      "token": "<agent token>"
    },
    {
      "name": "yd-mbp-tart-2",
      "kind": "virtual",
      "identity": "Tart on M4 Max MacBook",
      "url": "http://<macbook-ipv4>:9103",
      "token": "<agent token>"
    }
  ]
}
```

`hosts[].name` 是历史数据的稳定键；已有配置中的 `mini-1` / `mini-2` 不应为了改显示名称而重命名，界面优先展示 agent 上报的主机名。`kind` 必填且只允许 `physical`（物理机）或 `virtual`（虚拟机）；`identity` 是可选的设备身份描述。类型和身份由配置保存，不从机器型号推断，离线时也保留。升级已有配置时，需先为每台节点补齐 `kind`。

可选 GitHub 接入使用 `plugins.runners.options.repositories` 数组，每项为 `{ "repo": "owner/repo", "token": "<仓库 token>" }`，令牌需要读取对应仓库 Runner 的权限。仓库连接互相独立；未配置不会影响本地发现和启停。安装新 Repo 的 Runner 后会自动出现在对应仓库下，接入步骤和协议见 [插件系统](docs/plugins.md)。

Agent 配置 `~/.config/mini-archipel/agent.toml`（600）：

```toml
bind = "0.0.0.0:9101"
token = "<agent token>"
[collectors]
proc_interval_ms = 2000
thermal_interval_ms = 5000
fan_interval_ms = 2000
disk_interval_ms = 21600000
macmon = "/opt/homebrew/bin/macmon"
fanctl = "/Library/MacMiniFanControl/fanctl"
disk_roots = ["~"]

[plugins.runners]
enabled = true
[plugins.runners.options]
interval_ms = 5000
allow_control = true
```

## 访问与运维边界

- Agent API 使用 Bearer token。Console 只在服务端持有 agent / GitHub 凭据，传给 curl 的认证头通过 stdin 提供。
- 浏览器使用 8 小时有效的签名 HttpOnly、SameSite=Strict 会话；API 客户端也可用 Bearer。HTTP 与 WebSocket 均校验认证，写操作和 WebSocket 拒绝跨站 Origin。
- 当前部署面向可信私有网络。跨公网使用应在前面配置 HTTPS 与相应的网络访问控制；仅 HttpOnly Cookie 不提供传输加密。
- Runner 服务控制需要节点插件启用，并明确设置 `plugins.runners.options.allow_control = true`。从 runner 的 `.service` 找 LaunchAgent，目录或仓库改名不会使控制失效；控制台复核插件快照，Agent 执行前再次检查真实 Worker。
- macOS 本地网络隐私会影响自编译程序，因此 console 经系统 curl 访问 agent。`.local` 可能广播无路由的 IPv6，跨机采集宜固定可达的 IPv4。
- 磁盘扫描开销高，按 6 小时或手动触发；CPU 高时延后。扫描通过 SSH 回环绕开 launchd IO 节流，APFS firmlink 需避免重复计数。

## 语言与外观

登录页与工作台右上角均可选择：

- 语言：系统 / 中文 / English。系统使用浏览器首选语言，中文语言区域使用中文，其余使用英文。
- 主题：系统 / 浅色 / 深色。系统实时跟随操作系统配色。

两项默认均为系统。手动选择保存在当前浏览器；切回系统后恢复自动跟随，同源标签页同步。无存储权限时，本标签页仍能切换。主题在首屏绘制前应用，减少闪烁；减少动态效果遵循系统偏好。

文案使用 Lingui 6，消息在 `console/src/locales/{zh,en}/messages.po`，包含插件、提示、错误及无障碍名称。修改文案后运行 `npm run i18n:extract`，补齐两种语言，再运行 `npm run i18n:check`。构建会拒绝遗漏或未同步的翻译。Ant Design 的语言、主题算法和自定义 CSS 同步切换。

## 0.6 命名迁移

现有四节点的监控程序、配置、日志、SQLite 数据及 LaunchAgent 迁入本文的新名称；宿主机的两条监控隧道也使用 `local.miniarchipel.tunnel.*`。历史节点键、节点令牌、GitHub Runner 注册与工作目录不变。旧程序和数据库快照仅保存在发布归档中，不运行两套服务。
