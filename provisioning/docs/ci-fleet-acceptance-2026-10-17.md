# 四仓库 CI 机群验收 · 2026-10-17

本记录保留四仓库接入时的证据。随后统一安装目录并部署了更新的 Agent 与
共享维护脚本；现行路径及部署摘要见[Runner 目录迁移验收](runners-path-acceptance-2026-10-17.md)。

## 部署范围

四节点各安装四仓库的独立 Runner，共 16 个实例；GitHub API 核对全部 online。
原 Flowbit 的注册 ID 保留，未复制认证身份。安装器只在无 Worker 时重启监听服务。

| 仓库 | yd-mini | yd-mini-2 | yd-mbp-tart | yd-mbp-tart-2 |
| --- | --- | --- | --- | --- |
| `yaindrop/flowbit` | 29 | 30 | 31 | 32 |
| `yaindrop/flowbit-knowledge` | 22 | 24 | 21 | 23 |
| `yaindrop/in-frames` | 22 | 21 | 23 | 24 |
| `yaindrop/mini-archipel` | 3 | 2 | 4 | 5 |

表中 ID 属于各仓库自己的编号空间。安装目录 `~/runners/<repo>`；
名称 `<repo>-<节点名>`。Runner 2.338.0 的官方 ARM64 包 SHA-256：
`df4cebda25c86a886ed204e49fee63f5c2e7cec5f447b5c98440a826bbdf9df2`。
不禁用官方自动更新。

共同调度标签为 `self-hosted, macOS, ARM64, ci`，另有 `physical` / `virtual`
与 `node-<节点名>`。已验证容器的两台物理机，各仓库 Runner 都增加 `container`。
Flowbit 专项能力标签保留；虚拟机不再使用 `tart` 类型标签。

## 主动入口

四仓库统一用本仓库 PR 的 `run-ci` 标签请求 `PR Quality`；作业开始后消费标签。
只有明确请求才执行检查。push、普通 PR 活动与 schedule 不执行质量检查；
Flowbit 的 benchmark / core regression 改为仅显式手动调用。
四仓库已备好 `run-ci` 标签。本轮没有给 PR 加标签或主动发起项目 Actions 作业。

四套 workflow 均通过 actionlint；额外解析全部 YAML，确认没有 push / schedule，
PR 只监听 labeled，Quality 只接受 `run-ci` 与本仓库来源，且不自动取消进行中的请求。
旧 mini-archipel 自动 Console checks workflow 已停用，新入口替代旧文件。

## 节点保护与钩子

16 个安装的 `.env`、`.path`、用户服务和认证文件权限均复核；四节点共用相同脚本：

| 文件 | SHA-256 |
| --- | --- |
| `ci-lease.py` | `46414938014dffd8d6baab1ee0458165ff2e0bf10ae3f8c8ae18216eea02c7d9` |
| `ci-housekeeping.py` | `55ac59b60fcaf45b8c8f33fecdb2b4ad3a0e40ccc75d352fc86ccaa149205c85` |
| `job-started.sh` | `5b75441ba8c82f43a6d10a1a76150fc2af490ea5352ef1f8e96b29dac2ef23e1` |
| `job-completed.sh` | `f488a620eec7f1c42f7e107dcbd966db36a2f7c9ce526ff15d46e02d27cf13f2` |

同节点四仓库通过真实 Worker 的 PID + 启动时间共享作业租约；等待者取消或超时
不能释放他人的租约，也不能进入维护。完成维护后释放，Worker 死亡后自动回收。
旧 Flowbit 专用维护脚本移到 `~/.local/share/mini-ci/backups/previous-housekeeping/`，
当前监听进程全部使用通用钩子，不运行两套实现。

本地 8 项测试覆盖并发争抢、跨仓库占用与释放、进程死亡 / PID 复用、坏状态、
非 Worker 拒绝、无租约拒绝维护、源码 / 跟踪文件 / 软链接保护。Ruff 和 ShellCheck 通过。
`yd-mini`、`yd-mini-2`、`yd-mbp-tart` 的真实进程祖先探针通过，租约释放后没有残留。
第四台有用户原本请求的 Flowbit 作业，未中断它：Worker 日志确认执行新开始钩子，
租约记录与真实 Worker / Actions run `39028506346` 对应；当时未额外运行探针。
这不代表该运行中的项目作业已经完成或通过。

两台物理机均启动 Colima，成功运行 ARM64 hello-world 后停止；第二台另验证
拉取 Nginx、客体代理地址和容器到宿主测试 HTTP 服务的访问。Knowledge workflow
使用客体可访问的构建代理、当次运行独立镜像标签，结束后删除镜像并停止引擎。
虚拟机不承担需要本机容器引擎的完整 Knowledge 检查。

## 插件与本地项目检查

Console 0.6.0 / Agent 0.4.0 的 Runner 插件 v2 自动发现全部 16 个实例。
真实 API 与页面确认四个 Repo 各 4 个节点，监听 PID 与安装路径匹配；核心监控四节点在线。
未配置的 GitHub 远端连接仍明确显示“本地进程状态”，不复制开发者 gh 凭据充当运行凭据。
远端 online 由本轮管理端 GitHub API 单独核对；插件远端状态可后续配仓库只读专用凭据。

- In Frames 当前工作树的 `make check` 完整通过：Python 439 项、覆盖率 93.47%，
  Web 单元 56 项、浏览器 54 项，以及类型、lint、文档、合同和构建门禁。
- Knowledge 本地 `pnpm check` 通过：工具 / QA 测试、813 页构建、双语登记与 170262 条站内链接。
- Flowbit 本次改动只涉及 workflow 与 CI 文档，actionlint 与变更文件 Prettier 通过；
  没有再次执行其完整 `pnpm check:all`。
- Mini Archipel 本次没有修改应用运行代码；workflow 与文档检查通过，生产插件实际发现验收通过。

注册 online、节点钩子探针、本地项目检查和真实 Actions 项目 CI 是不同证据。
本轮未为了配置验收主动消耗四仓库的 Actions 全量检查；首次明确请求后的结果需另行记录。


## GitHub 远端状态接入（后续验收）

四仓库的专用凭据已接入 Console 私有配置；当前插件仅调用 Runner 列表读取接口，
不使用该凭据触发 CI。配置权限为 600，凭据未进入源码、Git 历史或浏览器 API 响应。
仅重启 Console 加载连接，Agent 与 16 个 Runner 服务保持运行。

四个 Repo 的插件轮询均成功，分别取得 4 个 online、busy=false 的 Runner，
与本地 16 个安装的仓库、注册 ID 和名称逐项匹配。页面已显示 GitHub online 与“可接单”；
核心监控四节点在线。先前“远端凭据后补”是当时快照，此项现已完成。
