# 四机对齐验收 · 2026-10-17

本记录对应 README 的实体机 / Tart 类型规则。共同运行环境已经部署并验证；
**整体验收仍有未关闭项**，见末尾，不以机器专属例外代替。

## 机器与真实作业

| 主机            | 类型                            | runner ID / 版本 | 实际 Actions 作业                                                                       |
| --------------- | ------------------------------- | ---------------- | --------------------------------------------------------------------------------------- |
| `yd-mini`       | Mac18,5 / M6 / 16 GiB           | 29 / 2.338.0     | [39002640494：成功](https://github.com/yaindrop/flowbit/actions/runs/39002640494)       |
| `yd-mini-2`     | Mac18,5 / M6 / 16 GiB           | 30 / 2.338.0     | [39002667031：成功](https://github.com/yaindrop/flowbit/actions/runs/39002667031)       |
| `yd-mbp-tart`   | VirtualMac2,1 / 6 vCPU / 16 GiB | 31 / 2.338.0     | [39003442981：重启后成功](https://github.com/yaindrop/flowbit/actions/runs/39003442981) |
| `yd-mbp-tart-2` | VirtualMac2,1 / 6 vCPU / 16 GiB | 32 / 2.338.0     | [39003470749：重启后成功](https://github.com/yaindrop/flowbit/actions/runs/39003470749) |

四台均为 macOS 27.0.1（26A434），GitHub 最终查询均为 online、busy=false。
实际执行的是仓库现有 `dev-remediation-boundaries.yml` 验收作业；验证接单、
运行及完成钩子，**不代表 Flowbit 全量 CI 已通过**。两台 Tart 在移除本机旧
runner 前也分别通过了 [39001831355](https://github.com/yaindrop/flowbit/actions/runs/39001831355)
与 [39001865486](https://github.com/yaindrop/flowbit/actions/runs/39001865486)。

## 逐项结果

“通过”指本次有实际检查；“不适用 / 豁免”来自类型规则；“待验证”不是通过。

| 规则 / 检查                                             | yd-mini        | yd-mini-2    | yd-mbp-tart    | yd-mbp-tart-2  |
| ------------------------------------------------------- | -------------- | ------------ | -------------- | -------------- |
| 三项远程服务开启，指定账户授权                          | 通过           | 通过         | 通过           | 通过           |
| SSH 显式公钥登录                                        | 通过           | 通过         | 通过           | 通过           |
| 远程管理：实际查看、鼠标键盘操作                        | 通过           | 通过         | 通过           | 通过           |
| 远程 Apple 事件：3031 可达                              | 通过           | 通过         | 通过           | 通过           |
| 远程 Apple 事件：认证往返                               | 待验证         | 待验证       | 待验证         | 待验证         |
| `sleep 0` / `displaysleep 10`                           | 通过           | 通过         | 通过           | 通过           |
| 接电启动 / 网络唤醒                                     | 通过           | 通过         | 不适用         | 不适用         |
| FileVault                                               | 开启           | 开启         | 豁免，关闭     | 豁免，关闭     |
| SIP / 防火墙                                            | 开启           | 开启         | 开启           | 开启           |
| 自动下载、手动安装系统更新；安全更新自动                | 通过           | 通过         | 通过           | 通过           |
| 蓝牙关闭、AirDrop 关闭、Handoff / AirPlay 接收关闭      | 通过           | 通过         | 通过           | 通过           |
| 黑色静态壁纸实看、屏保关闭、Siri 关闭、小组件隐藏       | 通过           | 通过         | 通过           | 通过           |
| Spotlight 索引关闭、文件共享关闭                        | 通过           | 通过         | 通过           | 通过           |
| v2rayN 7.25.6：界面、三节点、10809 实测                 | 通过           | 通过         | 通过           | 通过           |
| 三节点分别经独立内核访问 GitHub                         | 3/3 HTTP 200   | 3/3 HTTP 200 | 3/3 HTTP 200   | 3/3 HTTP 200   |
| GUI 正常退出后，10808 独立代理可用                      | HTTP 200       | HTTP 200     | HTTP 200       | HTTP 200       |
| 固定工具链检查脚本                                      | 返回 0         | 返回 0       | 返回 0         | 返回 0         |
| 同一提交的 pnpm 冻结安装 / Python SDK 冻结安装及导入    | 通过           | 通过         | 通过           | 通过           |
| Python / Rust 原生 / WASM 编译 / OpenMP / Chromium 渲染 | 通过           | 通过         | 通过           | 通过           |
| Colima 启动、hello-world、ARM64 容器                    | 通过，已停止   | 通过，已停止 | 平台不支持     | 平台不支持     |
| runner 正式仓库名、目录、服务名、配置权限               | 通过           | 通过         | 通过           | 通过           |
| 作业完成钩子：complete、无 warning                      | 通过           | 通过         | 通过           | 通过           |
| mini-archipel agent 与 runner 控制接口                     | 通过           | 通过         | 通过，启停实测 | 通过，启停实测 |
| 物理风扇守护进程与统一曲线                              | 通过           | 通过         | 不适用         | 不适用         |
| 本轮重启恢复                                            | 待验证         | 待验证       | 客体重启通过   | 客体重启通过   |
| 无 CI 验收遗留 Worker / Chromium / v2rayN GUI           | 通过           | 通过         | 通过           | 通过           |
| 无其他交互任务、完整静默基线                            | 待确认交互任务 | 通过         | 通过           | 通过           |

风扇读数由温度和滞回状态决定，不要求两台实时 RPM 相同。既有四档实写与
负载验收见[风扇章节](09-fan-control.md)；本轮未修改风扇程序或曲线。

## 共同环境

- 正式仓库：`yaindrop/flowbit`；目录：`~/github-runners/flowbit`；服务：
  `actions.runner.yaindrop-flowbit.<runner-name>`。无旧 `flow-bit` 活动服务。
- runner 的 RunAtLoad / KeepAlive 为 true，重启节流 10 秒，退出等待 30 秒。
  `.runner`、`.credentials*`、`.env`、`.path`、`.service` 权限为 600。
- 四台共同标签：`self-hosted, macOS, ARM64, flowbit-primary, flowbit-ci, flowbit-lint`。
  实体机增加 `physical, flowbit-container`；Tart 只增加 `tart`。
  已移除旧单机专用标签 `flowbit-mini-2`。
- v2rayN 位于 `~/Applications/v2rayN.app`。节点为 `akko-lon / akile-de / akile-lax`，
  默认 London；GUI 10809、独立 CI 10808，仅回环监听，TUN 关闭。
  四台 GUI 配置均已加入本地名称、实体机网段与 Tart NAT 网段的代理绕过项。
- 代理 GUI 配置目录权限 700，数据库、JSON 与 CI 配置权限 600。
  导入用的临时凭据副本已删除；必要运行配置及私有回滚备份保留。
- 两台 Tart 已安装独立控制机 SSH 密钥，主机公钥彼此不同；禁用空密码
  SSH 后，公钥认证成功，无凭据登录被拒绝。自动登录和免密 sudo 按类型规则保留。

固定版本：Node 26.11.1、pnpm 12.10.1、Corepack 0.36.0、Python 3.14.7、
uv 0.13.0、Ruff 0.17.0、Rust 1.98.1、nightly-2026-08-02、wasm-pack 0.15.0、
CMake 4.4.3、clang-format 23.1.1。辅助工具 Docker CLI 29.9.1、Colima 0.10.3、
gh 2.102.0 也已一致。

四台均使用 Flowbit `cc0ae8eeb8e8ac21c30c5d2182c13cf30172d037` 的独立验收目录，
`pnpm install --frozen-lockfile` 成功。按项目脚本先生成 SDK 打包文档，再执行
`uv sync --frozen --extra mcp --extra authoring`，四台都成功导入 SDK、MCP、
jsonschema、NumPy 与 XGBoost。实体机另在既有 runner 工作区完成基础运行时
验证。未把工具链版本检查或轻量作业记为项目全量构建验收。

以下文件 SHA-256 在四台一致，按校验值核对，不按文件名推断：

| 文件                                      | SHA-256                                                            |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `~/.config/flowbit-ci/environment.sh`     | `0a45778467933ecd4b0934b275c0b11ac52f98e963f02c793cf15accd0935746` |
| `~/.local/bin/flowbit-ci-housekeeping.sh` | `f0ca9d2d4cefa6ee90426ec2271fa39e41b80ac09d53bdd7b50338da4a621f2f` |
| `~/.local/bin/flowbit-ci-housekeeping`    | `1ef8eea1bd2d9daca8df297bdf53a0f595557b79500b87ac7b993765dfcf6fa7` |
| `~/.local/bin/flowbit-ci-proxy-select`    | `a981c7e560d6be8264e627c873f79287bf33b92b089ce19cac8432eec9095343` |
| `~/.local/libexec/mini-archipel-agent`       | `8114ee508c744ade47fba6984f789945e6c5baad53705f2a1528d05602f45684` |

群岛（mini-archipel）已发布 Console 0.6.0 / Agent 0.4.0，四台使用上表同一 release
二进制。Runner 采集、控制与页面已移入可独立启停的插件，核心不再拥有
Runner 逻辑。所有 `.app` 后缀（大小写不敏感）统一归为应用，
新增分类测试通过；四台目录新扫描完成后使用同一分类规则。四台统一显式启用 `plugins.runners`，采集间隔 5000 ms、
`allow_control = true`；旧全局控制环境变量和旧专用 API 已移除。

四台已分别完成插件关闭／恢复验证，基础监控保持在线、禁用数据清空；控制台
插件也可独立关闭／恢复。真实 Runner.Listener PID 全部保持不变，未发送真实
CI 服务启停命令。配置权限 600、原令牌和历史主机键保留，数据库备份通过
`quick_check`。Rust 格式、Clippy、6 项单元测试及真实 Agent HTTP 生命周期
测试通过。浏览器、类型与静态检查结果见 mini-archipel 的 `console/ENGINEERING.md`。

Runner 插件协议已升级为 v2，管理层级为 Runners → Repo → 各节点 Runner。
四台均从 `.runner` 识别到 `yaindrop/flowbit`，新增 Repo 的独立安装会自动发现。
本轮覆盖同节点多 Repo、跨仓库同名同编号、独立启停、分页和连接故障隔离；
37 项控制台单元／接口测试、5 项桌面及 1 项手机浏览器检查通过。线上只更新
监控服务，四个 Listener PID 保持 61511、83147、554、554，运行中的 Worker
未改变；未发送真实 CI 服务启停命令。

## 重启、宿主机与旧 runner

两台 Tart 实际重启后均自动登录，SSH、CI 代理、mini-archipel agent 和监控隧道
自动恢复；runner 在约 3 分钟内处理启动重试与旧会话释放，重新 Listening
for Jobs，并分别执行了上表的重启后作业。未重启宿主机，因此不声称宿主机
解锁、登录及 Tart 启动链路已经过重启验证。

宿主机 FileVault 开启，Tart 镜像目录权限 700，客体使用 NAT。
SSH 别名 `yd-mbp-tart` / `yd-mbp-tart-2` 已配置；当前地址为 192.168.64.2 / .3，
若地址变更需用 `tart ip <name>` 核对并更新别名。
两个监控隧道各有独立 LaunchAgent，使用对应密钥、校验主机密钥，并在客体
重启后恢复。监控隧道不承担代理出口。

本机实际旧目录为 `~/runners`，含两套旧 runner；在两台 Tart 首轮真实作业
成功后移入回收站 `~/.Trash/runners-retired-20261017-121700`。最终确认
`~/runner`、`~/runners` 均不存在，本机无 runner 进程或活动 LaunchAgent。
GitHub 正式列表仅保留这四台。

## 资源快照

以下为早期采样：当时均无 Actions Worker，`yd-mini` 有 ChatGPT/Codex
交互进程，因此它的读数不是完全静默基线。内存口径为 `top` PhysMem，包含可回收页；不以
占用总量单独判定泄漏。四台 swap 均为 0。

| 主机          | Data 已用 / 可用 | CPU idle | 压缩内存 |
| ------------- | ---------------- | -------- | -------- |
| yd-mini       | 43 / 160 GiB     | 97.49%   | 2027 MiB |
| yd-mini-2     | 46 / 157 GiB     | 93.10%   | 593 MiB  |
| yd-mbp-tart   | 16 / 192 GiB     | 98.43%   | 0        |
| yd-mbp-tart-2 | 17 / 191 GiB     | 98.43%   | 0        |

## 未关闭项

1. 四台远程 Apple 事件的认证往返：服务、授权组、防火墙和 3031 端口已检查；
   本次从控制机脚本编辑器读取 `yd-mini` 的 Finder 版本未返回，客户端随后
   无法正常响应自动化读取。尚无四台认证成功的结果，不能标记通过。需继续
   排查客户端并在用户可处理账户认证时补验。
2. 两台实体机本轮重启恢复、宿主机重启后 Tart 启动链路未测。实体机涉及
   FileVault 解锁和桌面登录，须在能完成认证、且交互任务结束后安排。

全量 Flowbit CI 不属于本次基础设施验收已证明的范围。用户已授权正常退出
交互应用；17:27 复查四台均无 ChatGPT/Codex 应用进程，此项已关闭。

### mini-archipel 命名切换

GitHub 与本地仓库改为 mini-archipel、mini-provisioning、mini-fan-control；引用同步更新。监控配置、数据、日志、服务与宿主机隧道统一迁移新名称。两台物理机已由管理员更新防火墙应用许可，允许当前 Agent 路径，移除旧路径；虚拟机沿用宿主机保障的安全分类。四台 Agent 为 0.4.0，Console 为 0.6.0，原 Runner 进程与历史数据保留。

17:27 安全基线复核：四台 SIP 和系统防火墙实际均开启。虚拟机规则允许私有 NAT 客体由宿主机保护、不强制额外启用客体防火墙；当前已开启的状态符合规则，无需为追求一致而关闭。两台物理机必须保持开启并放行当前监控 Agent。
