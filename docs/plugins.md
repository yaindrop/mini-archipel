# 插件系统

核心负责节点连接、认证、基础资源采集、存储历史、实时传输和工作台框架。Runner 是可选的内置插件，其采集、GitHub 集成、服务控制、数据校验、导航、节点面板和样式都由插件拥有。

## 注册和职责

| 层             | 通用机制                                                                       | Runner 实现                             | 唯一注册位置                            |
| -------------- | ------------------------------------------------------------------------------ | --------------------------------------- | --------------------------------------- |
| Agent          | `agent/src/plugins/mod.rs` 的 Plugin / Manager / Context                       | `agent/src/plugins/runners.rs`          | `agent/src/plugins/catalog.rs`          |
| Console 服务端 | `console/src/plugins/runtime.ts`                                               | `console/src/plugins/runners/server.ts` | `console/src/plugins/catalog.server.ts` |
| 工作台         | `console/src/web/plugins.tsx` 的 WorkbenchPlugin / PluginProvider / PluginSlot | `console/src/plugins/runners/`          | `console/src/plugins/catalog.web.tsx`   |

插件随产物编译注册，启停即时生效，不需要重启核心。修改插件代码或安装新的插件需要重新构建产物。新增插件只添加自己的实现和注册项；核心不按插件 ID 分支，不导入具体插件的类型或操作。

服务端插件接口提供读取公开状态、处理自身操作、开始和停止后台任务。前端插件可贡献路由、导航计数、概览表格列、概览面板、节点面板和连接诊断面板。插件渲染错误由 PluginSlot 局部承接。服务端插件初始化和状态读取失败会反映为插件错误，基础监控继续运行。

Agent 插件可通过 `Plugin::disk_expansions()` 声明需要在目录空间分析中展开一级的绝对目录。
Manager 只汇总当前启用且运行中的声明；磁盘采集器执行通用的直接子目录扫描，核心不按插件名称判断。
插件开关变更后请求重扫，新的扫描结果随声明增减。Runner 插件声明 `~/runners`，仅展示下一层各仓库目录，
不继续展开工作区；关闭插件仍保留该目录的基础空间统计。节点详情纵向展示所有仓库 Runner，总览按 Repo 切换。

## 启停语义

- **控制台开关**：停止该插件的后台集成，撤下导航和扩展内容，拒绝该插件的操作；节点上的插件保持自己的状态。
- **节点开关**：停止该节点插件的采集任务，清空该插件的有效数据并拒绝其操作；其他节点与基础采集继续运行。
- **Runner 服务操作**：只有 Runner 插件中的“启动接单／停止接单”会改变 CI 服务。插件启停从不调用 Runner 的 launchctl 操作，不中断正在运行的 Worker。

控制台和节点开关分别持久化到本机配置。切换成功必须先保存配置；写入失败时保留原运行状态。配置文件以私有权限写入临时文件后原子替换。生命周期变更与插件操作按序执行，避免关闭插件时仍发出旧操作。

在“插件管理”页分别切换控制台与各节点。暂停资源监控后，显式操作仍会刷新插件状态，资源读数保持暂停时的快照。

## 数据协议

Agent 的基础快照中只有一个扩展容器：

```json
{
  "plugins": {
    "runners": {
      "version": 2,
      "enabled": true,
      "status": "ready",
      "ts": 1792200000000,
      "error": null,
      "data": {
        "interval_ms": 5000,
        "control_allowed": true,
        "runners": []
      }
    }
  }
}
```

通用信封包含协议版本、开关、`disabled / starting / ready / error` 状态、更新时间和插件自有数据。协议版本由插件声明。关闭后 `data` 为 null。

核心将 `snapshot.plugins` 作为不透明的命名空间记录透传，不删除未知插件及其字段。每个插件负责校验自己的信封版本与数据。未知版本、坏数据或采集故障只影响该插件，不能将基础资源判为离线。

Console 的 `archipel.plugins` 返回已注册插件的公开元数据、启用状态、错误和自身状态数据。Runner 的 GitHub 状态及远端列表位于 `archipel.plugins.runners.data`。Agent token、GitHub token 和私有插件选项不返回浏览器。

## 通用接口

所有 Console `/api/` 接口沿用工作台会话／Bearer 认证和跨站写入检查；Agent 接口使用节点 Bearer token。

| 接口                                                      | 作用                                         |
| --------------------------------------------------------- | -------------------------------------------- |
| `PUT /api/plugins/:id`，`{ "enabled": true }`             | 控制台插件启停                               |
| `PUT /api/hosts/:host/plugins/:id`，`{ "enabled": true }` | 指定节点插件启停，即使控制台插件关闭也可使用 |
| `POST /api/plugins/:id/actions/:action`                   | 已启用控制台插件的自有操作                   |
| Agent `PUT /plugins/:id`，`{ "enabled": true }`           | 节点保存开关并立即切换运行状态               |
| Agent `POST /plugins/:id/actions/:action`                 | 已启用且就绪的节点插件操作                   |

Runner 使用 `actions/toggle`，控制台请求为 `{ "host": "节点ID", "repo": "owner/repo", "runner": "安装目录名", "enable": false }`；转发到节点时不包含 host。Repo 和安装目录必须同时匹配当前注册记录，不能用 Runner 名称跨仓库查找。Agent 在实际操作前重新检查注册仓库和该安装目录的 Worker。

`actions/interrupt` 接收 `{ "host": "节点ID", "repo": "owner/repo", "runner": "安装目录名", "worker_pid": 123 }`。
它在节点本地重新核对注册仓库、Worker 的完整可执行路径、用户和预期 PID，作业已变化时返回 409。
确认后向该 Worker 和同用户的已识别子进程先发送 SIGTERM，等待后对仍存在的相同进程发送 SIGKILL；
进程身份包含启动时间，避免误用已回收 PID。Listener、其他仓库和无关进程不在中断范围。
此操作不调用 GitHub 取消接口，不停止接单服务，不能撤销；需要与启停相同的控制权限。
暂停资源读数后，插件状态与扫描任务状态仍更新。

旧的 `/api/runner/toggle`、`/runner-service` 和顶层 `snapshot.runners` 已移除。不存在旧接口转发或双写实现。

## 配置

Console `~/.config/mini-archipel/console.json`：

```json
{
  "plugins": {
    "runners": {
      "enabled": true,
      "options": {}
    }
  }
}
```

## 按仓库管理 Runner

管理层级是 **Runners → Repo → 各节点的 Runner**。一台节点可同时安装多个仓库的 Runner；同一仓库也可在多个节点安装。仓库以完整的 `owner/repo` 标识，节点安装实例以“节点 + 安装目录”标识，仓库名称、Runner 名称或编号相同也不会跨仓库关联状态。

Agent 自动扫描 `~/runners/<独立安装目录>/.runner`，从注册信息的 `gitHubUrl` 读取仓库归属。新增仓库只需在独立目录完成 Runner 注册和用户服务安装，下一轮采集自动出现在对应 Repo 下，无须修改监控仓库清单。不同 owner 的同名仓库必须使用不同安装目录。未识别的注册仓库单独展示，服务操作不可用；没有 `.runner` 的目录不计为安装实例。

本地发现和控制不依赖 GitHub token。可选远端状态连接按仓库配置在 `plugins.runners.options.repositories`，每个仓库各自保存凭据、更新时间和错误：

```json
{
  "repositories": [
    { "repo": "owner/first", "token": "<first repository token>" },
    { "repo": "owner/second", "token": "<second repository token>" }
  ]
}
```

此列表默认空，不向浏览器返回 token；仓库标识不区分大小写且不能重复。某仓库连接失败不影响其他仓库或本地管理。每个仓库独立分页采集、30 秒刷新，远端数据超过 90 秒失效。读取权限依据 [GitHub 仓库 Runner API](https://docs.github.com/en/rest/actions/self-hosted-runners#list-self-hosted-runners-for-a-repository)。

当前群岛在四节点各部署 `yaindrop/flowbit`、`yaindrop/flowbit-knowledge`、
`yaindrop/in-frames`、`yaindrop/mini-archipel` 四个仓库的独立 Runner，共 16 个实例。
它们使用本仓库 [provisioning](../provisioning/docs/08-github-runner.md) 模块统一的节点作业租约和完成维护钩子；插件负责发现、按 Repo 展示与
服务控制，不负责触发 CI。各仓库只通过明确的 `run-ci` 请求执行 PR Quality。

旧的单仓库 `githubRepo` / `githubToken` 配置已移除；已有非空配置需迁入 `repositories`。Runner 协议升级为 2，Console 0.6.0 与 Agent 0.4.0 配套部署；不保留旧协议的操作分支。

Agent `~/.config/mini-archipel/agent.toml`：

```toml
[plugins.runners]
enabled = true

[plugins.runners.options]
interval_ms = 5000
allow_control = true
```

`interval_ms` 范围为 1000–60000。`allow_control` 默认 false；只有明确设置为 true 才允许 Runner 服务启停。插件数据超过三个采集周期且至少 15 秒未更新时，不允许操作。控制台检查节点、插件与作业状态，Agent 在操作前再次检查真实 Worker。

裸安装默认禁用可选插件。CI 节点按 provisioning 明确启用 Runner 插件；实体机与虚拟机使用相同插件规则。

在首次启动或维护窗口内，可用通用离线配置命令；选项从 stdin 读取，合并已有选项并校验，保留凭据：

```sh
printf '%s\n' '{"interval_ms":5000,"allow_control":true}' |
  ~/.local/libexec/mini-archipel-agent configure-plugin \
  ~/.config/mini-archipel/agent.toml runners true
~/.local/libexec/mini-archipel-agent check-config ~/.config/mini-archipel/agent.toml
```

`check-config` 成功时只输出监听地址。离线修改需要重启 Agent；日常启停使用工作台开关，立即生效。不要同时在文件里手动编辑与在工作台更改同一个运行中配置。

## 验证与发布

```sh
cd console
pnpm install --frozen-lockfile
pnpm check
pnpm check:agent
pnpm test:browser
pnpm audit
```

验证覆盖空插件目录、第二个测试插件、未知数据透传、坏数据隔离、生命周期互斥、持久化失败回滚、重启恢复、作业保护、暂停状态下的显式变更，以及浅色／深色和手机界面。架构测试禁止核心模块重新出现 Runner 或 GitHub 依赖。真实 Agent HTTP 测试使用临时配置、随机回环端口和禁用的 CI 控制权限。

发布先升级 Console，使其可接受无插件的节点，再升级四个 Agent。旧节点暂不提供插件能力时，基础采集仍工作。保留配置、数据库、程序和 LaunchAgent 备份；安装器检查新版本健康接口，失败时恢复上一程序。回滚整个版本时一并恢复对应配置。

线上验收只切换监控插件并比对 Runner 进程，不发送真实 Runner 服务启停命令。完整机器重启恢复与 Agent 用户服务重启是不同的验收项。
