# 8. 自托管 GitHub Actions runner

## 注册与服务

1. 从 GitHub 官方 actions/runner 发布包安装 macOS ARM64 版，核对发布摘要；
   不禁用 runner 自动更新。
2. 安装目录 `~/runners/<repo>`（每仓库一个独立目录），工作目录 `_work`；每台每仓库一个正式 runner。后续仓库装在
   `~/runners/<repo2>`，互不干扰。
3. 各机独立注册加入目标仓库 `<owner>/<repo>`——**绝不复制旧机的
   `.runner`、`.credentials` 或私钥**；注册令牌一次性使用。
4. 用官方 `svc.sh install` 生成服务及 `runsvc.sh`，再核对用户级 LaunchAgent：
   RunAtLoad、KeepAlive、10 秒重启节流、30 秒退出等待。不可只手写 plist
   而漏掉入口脚本。重启时代理与 runner 的启动顺序不保证；短暂连接重试
   可以接受，最终必须恢复在线。
5. 固定 `.path`（工具链顺序）与 `.env`；注册信息与 env 文件权限 600。
6. `.env` 建议：`ELECTRON_GET_USE_PROXY=1`（Electron 下载走代理）、按项目
   需要固定构建开关（如 `VITE_MKCERT_ENABLED=0`），以及 Corepack 防漂移项
   `COREPACK_DEFAULT_TO_LATEST=0`、`COREPACK_ENABLE_AUTO_PIN=0`、
   `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`。
7. 共同调度标签：`self-hosted, macOS, ARM64, ci`，另加类型与节点标签。

**坑：`config.sh --help` 也会执行 env.sh 并覆盖 `.path`**——别拿它当
无副作用检查；每次配置/注册后复核固定 PATH。

仓库改名后使用 GitHub 的正式名称注册；网页/API 重定向成功不代表旧名称仍能完成注册。
服务标签由官方安装器生成，例如 `actions.runner.yaindrop-mini-archipel.mini-archipel-yd-mini`。
启停工具读取安装目录的 `.service`，不写死某个仓库的标签。

## 主动 CI 请求

四仓库共享清单为 [`scripts/ci-fleet.json`](../scripts/ci-fleet.json)。每仓库的
`PR Quality` 只监听 `pull_request: labeled`，只有本仓库 PR 新增 `run-ci`
标签才执行一个原生 `Quality` 作业；其他标签事件跳过检查。

```sh
gh pr edit <PR编号> --repo yaindrop/<repo> --add-label run-ci
```

作业开始后消费标签，复跑时重新添加。PR 更新后必须重新请求；此前结果只对应
请求时不可变的 PR merge commit。push、创建/更新/重开 PR 和定时任务不运行检查。
Agent 不主动加标签或触发 CI，除非人明确要求验证。等待机器时标签可以暂时保留。
不允许不受信任的 fork 代码在这组持久化节点上执行。

| 仓库 | 正式质量入口 |
| --- | --- |
| `flowbit` | `pnpm check:all`，保留现有分阶段完整检查和结果汇总 |
| `flowbit-knowledge` | `pnpm check`、`pnpm test:deployment` |
| `in-frames` | `make setup` 后 `make check` |
| `mini-archipel` | Node 26 的 Console 门禁、审计、浏览器测试，以及 Rust Agent 检查 |

仓库保留的专项诊断只可显式手动调用，不添加 push、普通 PR 或 schedule 入口。
工具版本由各仓库锁文件和 workflow 指定；不通过修改机器的全局默认版本迁就某个项目。

## 共享作业钩子与维护

四仓库的 `.env` 都使用 `~/.local/libexec/mini-ci/job-started.sh` 和
`job-completed.sh` 作为 [GitHub 同步作业钩子](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/run-scripts)。
脚本源文件统一维护在本仓库 `provisioning/scripts/`，不放进 Runner 应用目录。

开始钩子按真实 `Runner.Worker` 的 PID 与启动时间获取节点租约，最多等待 60 分钟。
同节点其他仓库的作业等待租约后才进入 checkout、安装和测试；四台机器仍可并行。
超时失败，不绕过保护。Worker 退出后的遗留租约自动回收，PID 复用不会误认原作业。
完成钩子在维护结束后释放自己的租约；未取得租约的作业不能维护别的作业的工作区。

| 对象 | 规则 |
| --- | --- |
| 当前 Runner `_diag` | 14 天 / 256 MiB，保留打开的日志及最近 5 个 |
| pnpm / uv 缓存 | 每 7 天尝试官方 prune |
| Rust `target` | 同节点全部注册仓库共享 32 GiB 预算，优先回收 7 天未使用的缓存 |
| SSD 余量 | 低于 40 GB 时可回收热 target |
| 保护 | 只回收 gitignore 排除、无跟踪文件、非软链接且位于注册工作区内的 target |
| 执行 | 租约拥有者维护；互斥锁、90 秒总限时、单命令超时，无常驻清理进程 |
| 失败 | 记录 warning，不改变项目检查结果；不删除源码或 node_modules |

工作区使用 `GITHUB_WORKSPACE`，历史写入
`~/.local/state/mini-ci/maintenance/history.jsonl`，租约位于
`~/.local/state/mini-ci/owner.json`。实际 Actions 的 Set up runner / Complete runner
日志用于确认生产作业钩子；进程探针只证明平台与脚本接线，不替代真实项目 CI。

## 节点接单互斥

Runners 页的「节点接单互斥」和节点详情 Runners 区域提供同一个按节点保存的开关，
默认关闭。开启后，开始钩子在取得节点租约、进入作业步骤之前，暂停同节点其他空闲
Runner 的 Listener；当前作业及维护结束后恢复。注册、工作区和 LaunchAgent 配置保留，
不调用 GitHub 的取消、禁用或调度接口，不触发 CI。

暂停使用本地 SIGSTOP / SIGCONT，只操作当前用户、准确安装路径和已记录启动时间的
Listener，不冻结 Worker。已同时分配的作业在共用开始钩子内等待租约，其 Listener
保持运行以便接收取消；等待作业不能执行 checkout、构建或测试。原有节点租约仍是
并发保护，关闭本开关只关闭对其他 Listener 的主动暂停，不移除原有作业串行规则。

开关及暂停进程身份以权限 600 原子写入
`~/.local/state/mini-ci/runner-policy.json`，与作业钩子、手动服务操作共用文件锁。
信号前保存恢复记录；只恢复本策略暂停且身份仍匹配的进程。手动停止的 Runner 不会
自动启动，在互斥期间也可手动停止已暂停的 Runner。关闭开关立即恢复策略暂停项；
插件停用不会更改这项已保存的本地 CI 策略，正常释放仍由完成钩子执行。

Agent 复用该控制端检查遗留状态，Worker 崩溃或本地中断导致完成钩子未执行时，
下一次采集恢复暂停项；Agent 重启从相同记录恢复。Agent 不可用且完成钩子也未执行时，
恢复 Agent 或在节点运行 `/usr/bin/python3 ~/.local/libexec/mini-ci/ci-lease.py state`
执行恢复检查。GitHub online / busy 状态存在延迟，界面的本地互斥标记优先。

此能力要求节点上每个已注册 Runner 都接入本章的共用钩子；安装新仓库时使用
`install-node-runners.py`，自动沿用同一机制。旧 Agent 或缺少钩子的节点开关不可用。
本地接口为 `POST /plugins/runners/actions/coordination`，请求体仅含布尔值 `enable`；
沿用节点鉴权、插件启用及 `allow_control` 授权，不需要仓库凭据。

## 多机策略

- 每个仓库每个节点一个 Runner，共四仓库 × 四节点 = 16 个实例。
- 共同标签 `self-hosted, macOS, ARM64, ci`；类型只能是 `physical` 或 `virtual`，
  节点定位标签为 `node-<主机名>`。不以虚拟化产品名作为机器类型。
- 只有已验收容器的物理机上各仓库 Runner 带通用 `container` 能力标签。
- Flowbit 专项工作流保留 `flowbit-primary`、`flowbit-ci`、`flowbit-lint` 能力标签；
  只有已验收容器的物理机带 `flowbit-container`。这些是仓库能力，不是另一套通用规则。
- 四个监听进程可同时在线，但共享节点租约使重作业串行；不按仓库各自放开节点并发。
- 备用机停用：`launchctl disable` + `bootout`（重启不自动接单），安装与
  注册保留。恢复：

```sh
label="actions.runner.<owner>-<repo>.<runner-name>"
domain="gui/$(id -u)"
launchctl enable "$domain/$label"
launchctl bootstrap "$domain" "$HOME/Library/LaunchAgents/$label.plist"
```

## 目录迁移（保留注册）

先暂时移除目标节点所有仓库 Runner 的自定义调度标签，等待 GitHub 显示
`busy: false`，并确认本机没有真实 `Runner.Worker`。备份注册文件、凭据、
LaunchAgent 和辅助脚本后再停止服务；保留 `.runner`、`.credentials*`、
`_work` 与日志，不运行 `config.sh` 或重新注册，也不留下旧目录的兼容链接。

每个 Runner 的服务使用官方脚本重建：

```sh
cd <当前安装目录>
./svc.sh uninstall          # 停服务、移除 LaunchAgent，保留注册
mkdir -p "$HOME/runners"
mv <当前安装目录> "$HOME/runners/<repo>"
cd "$HOME/runners/<repo>"
./svc.sh install            # 只生成 runsvc.sh、LaunchAgent 和 .service
```

启动前按本章基线设置 `RunAtLoad`、`KeepAlive`、`ThrottleInterval: 10`、
`ExitTimeOut: 30`，从 `.service` 读取实际服务名，执行 `launchctl enable`
和 `bootstrap`。同时更新 `.env` / `.path` 中的绝对路径、共享作业钩子、
代理切换助手及群岛 Agent。代理助手必须能从新目录识别 Worker，否则可能
在作业期间错误切换代理。

工作区内的 `.venv`、Rust `target`、`node_modules` 及 CMake 构建缓存可能
包含旧绝对路径。仅清理已确认由 Git 忽略且没有受跟踪文件的生成目录；
不跟随符号链接删除外部内容。保留源码、注册凭据、日志和全局下载缓存，
下一次主动 CI 按新路径重建生成内容。

恢复调度标签前，核对注册 ID 和凭据摘要未变、全部新路径服务启动、GitHub
在线、插件按仓库发现和启停正确，并验证共享作业钩子与节点锁。失败时恢复
原目录、原服务及辅助脚本。目录迁移验收不自动触发项目 CI；完整项目质量
检查仍由人主动添加 `run-ci` 标签，单独记录结果。

SSH 会话可以直接 `launchctl bootstrap gui/$(id -u) <plist>` 拉起。

恢复后在 GitHub 侧确认 online。新机直接用最终名称注册，不先注册旧名再改。
替代旧机时，至少让新 runner 各自执行一次真实作业并验证钩子，再卸载旧服务。
轻量验收证明接单与服务链路，不等于整个项目的完整 CI 已通过；报告中分开记录。

## 群岛工作台的 Runner 插件

四台 CI 节点使用同一版本的群岛（mini-archipel）Agent 和 `runners` 插件。Agent 的基础监控不依赖 Runner；在节点配置中明确启用插件和服务控制权限：

```toml
[plugins.runners]
enabled = true
[plugins.runners.options]
interval_ms = 5000
allow_control = true
```

Console 在 `plugins.runners` 下设置 `enabled: true`，可选的远端连接使用 `options.repositories` 数组，每项为 `{ "repo": "owner/repo", "token": "<仓库 token>" }`。仓库连接独立管理，不再使用单仓库 `githubRepo` / `githubToken`、顶层 GitHub 配置、全局 Runner 控制环境变量或旧的 Runner 专用接口。具体接口及初始化命令见 [插件系统](../../docs/plugins.md)。

一台节点可安装多个 Repo 的 Runner，每个实例使用独立的 `~/runners/<安装目录>` 和注册服务。群岛从 `.runner` 的 `gitHubUrl` 自动识别完整仓库标识，在 **Runners → Repo → 各节点 Runner** 下管理；新增仓库不需要手动添加监控目标。不同 owner 的同名仓库使用不同安装目录。启停同时校验仓库和安装目录，不用 Runner 名称模糊匹配。当前协议为 Runner 插件 v2，Console 0.6.0 / Agent 0.4.0。

群岛的节点清单将类型和身份分开记录：`hosts[].kind` 只允许 `physical`（物理机）或 `virtual`（虚拟机）；`identity` 记录设备及运行环境。两台 mini 的身份统一为 `M6 Mac Mini`，两台虚拟机统一为 `Tart on M4 Max MacBook`。身份描述不增加类型，也不改变历史数据的节点键；离线时仍保留这两项记录。

日常在“插件管理”分别控制控制台与四台节点，开关即时生效并保存。禁用监控插件只停止采集与该插件的操作能力，不停接单服务、不终止 Worker；只有插件中的“停止接单”会改变 CI 服务，执行前检查真实 Worker。实体机和 Tart 使用相同插件规则。

验收时切换每个节点的插件开关，确认核心采集保持在线、其他节点不受影响、Runner 进程不变，并核对重启 Agent 用户服务后开关恢复。此项不替代机器重启或真实 CI 作业验收。

Knowledge 的完整检查包含真实 Nginx 容器测试，使用 `ci, container` 标签调度到两台
已验收容器的物理机；使用本次 run 的独立镜像标签，结束后删除该镜像并停止 Colima。
虚拟机保留独立注册的 Runner，但不运行需要嵌套虚拟化的本机容器检查。
