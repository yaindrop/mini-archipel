# 节点配置与 CI 机群

本目录是 [mini-archipel](../README.md) 的节点配置模块，统一维护装机规范、共享 CI 脚本和机群验收记录。

把 Apple Silicon Mac mini 或 Tart macOS 虚拟机配成 **CI 节点**的实战手册。
日常 SSH 管理、远程管理访问桌面，运行自托管 CI。共同对齐运行环境和运维
接口；电源、磁盘加密、风扇与虚拟化能力按机器类型处理。

远程访问基线：**远程管理、远程登录、远程应用程序脚本三项必须同时开启**，
并为指定运维账户授权，配置与验证见[第 1 章](docs/01-accounts-and-remote-access.md)。

内容来自两台 M6 Mac mini 和两台 Tart macOS 客体的实际部署记录
（2026-09 至 2026-10）。历史测量值是参考，不是新机必须复现的指标。

## 适用范围

| 项目 | 实体 Mac mini | 受信任宿主机上的 Tart macOS |
| --- | --- | --- |
| 三项远程访问、代理、工具链、runner | 必须 | 必须 |
| FileVault | 开启 | 豁免，由宿主机磁盘加密保护镜像 |
| 自动登录、免密 sudo | 不设置 | 允许，用于 CI 启动与维护 |
| SIP | 保持系统默认保护开启 | 保持系统默认保护开启 |
| 防火墙 | 开启，放行指定运维服务和当前 Agent 路径 | 私有 NAT 客体可保持关闭，由宿主机和虚拟网络保护 |
| 接电启动、网络唤醒、物理散热 | 配置并验证 | 由宿主机负责；客体不适用 |
| Colima VZ / 本机 Docker 引擎 | 按需，实际验收 | 当前不支持；Docker CLI 可保留 |
| 黑色静态壁纸、关闭屏保与无用后台 | 配置 | 配置，不追求停光系统进程 |

Tart 豁免的边界与宿主机要求见[安全基线](docs/04-updates-and-security.md)。
不把“所有设置字面相同”作为对齐目标，也不为通过清单而关闭系统保护。

规则变更必须同时更新对应章节、验收项及四机验收记录，并在四台逐一实施、
核对。差异只能由上表的机器类型或已验证的硬件能力解释；不保留某台机器
专属的旧路径、旧服务名或旧调度标签。未完成的实施和验证必须列为待办，
不能通过增加例外或降低验收条件消掉。

配套仓库：[mini-fan-control](https://github.com/yaindrop/mini-fan-control)
——本手册第 9 章部署的自适应风扇控制守护进程。

## 阶段总览

| #   | 阶段                         | 章节                                        | 操作方式         |
| --- | ---------------------------- | ------------------------------------------- | ---------------- |
| 1   | 开箱、账户、远程访问         | [01](docs/01-accounts-and-remote-access.md) | 人在新机前       |
| 2   | 电源、FileVault 与登录会话   | [02](docs/02-power-and-sessions.md)         | 混合             |
| 3   | 系统功能与桌面精简           | [03](docs/03-system-trim.md)                | 大部分可远程     |
| 4   | 更新与安全基线               | [04](docs/04-updates-and-security.md)       | 远程             |
| 5   | 代理与网络（双入口）         | [05](docs/05-proxy.md)                      | 远程             |
| 6   | 基础工具与固定工具链         | [06](docs/06-toolchain.md)                  | 远程             |
| 7   | Docker 与 Colima             | [07](docs/07-docker.md)                     | 远程             |
| 8   | 自托管 GitHub Actions runner | [08](docs/08-github-runner.md)              | 远程             |
| 9   | 自适应风扇控制               | [09](docs/09-fan-control.md)                | 远程 + 一次 sudo |
| 10  | SSD 清理与静默基线           | [10](docs/10-cleanup-and-baselines.md)      | 远程             |
| —   | 新机验收清单                 | [checklist](docs/acceptance-checklist.md)   | —                |
| —   | 日常运维命令                 | [operations](docs/operations.md)            | —                |

## 当前四机部署（2026-10-17）

| 主机 | 类型 / 身份 | 仓库数 | Runner 数 |
| --- | --- | --- | --- |
| `yd-mini` | 物理机 / M6 Mac Mini | 4 | 4 |
| `yd-mini-2` | 物理机 / M6 Mac Mini | 4 | 4 |
| `yd-mbp-tart` | 虚拟机 / Tart on M4 Max MacBook | 4 | 4 |
| `yd-mbp-tart-2` | 虚拟机 / Tart on M4 Max MacBook | 4 | 4 |

四台均为 macOS 27.0.1。`yaindrop/flowbit`、`yaindrop/flowbit-knowledge`、
`yaindrop/in-frames`、`yaindrop/mini-archipel` 各有四个独立注册的 Runner，
安装在 `~/github-runners/<repo>`。统一采用 PR `run-ci` 标签主动请求质量检查；
push、普通 PR 活动与定时事件均不运行质量检查。每节点跨仓库只执行一个作业。
清单和共享脚本见 [scripts](scripts/README.md)，本轮范围与证据见
[CI 机群验收记录](docs/ci-fleet-acceptance-2026-10-17.md)。
在线状态是验收快照，日常以 GitHub 和群岛 Runner 插件为准。
逐项证据、类型豁免及未关闭项见[四机验收记录](docs/fleet-acceptance-2026-10-17.md)。

## 标识与路径约定

手册中的名称均为示例，部署时替换为自己的：

| 示例                      | 实际含义                              |
| ------------------------- | ------------------------------------- |
| `mini-1` / `mini-2`       | 各机短用户名、主机名与 SSH 别名       |
| `<owner>/<repo>`          | CI 目标仓库                           |
| `~/github-runners/<repo>` | runner 安装目录（每仓库一个）         |
| `~/.local/flowbit-ci-pinned/bin` | 当前 Flowbit 固定工具链入口（优先于 Homebrew） |
| `com.flowbit.ci-proxy`    | 当前独立 CI 代理 LaunchAgent 标识    |
| `192.168.<subnet>`        | 自己的局域网网段                      |

账户密码、SSH 私钥、代理节点凭据、runner 注册令牌**不写入任何文档，不从
旧机整套复制到新机**；每台机器独立生成身份。
