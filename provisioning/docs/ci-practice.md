# 主动 CI 规范

四个仓库共用同一套请求、排队和报告规则。质量命令、版本声明和锁文件仍由各仓库维护。节点租约、完成钩子和本地中断继续用现有的 `ci-lease.py`、`ci-housekeeping.py`、`job-started.sh`、`job-completed.sh`，本规范不替换它们。

## 请求、排队、重跑、取消

- 只有本仓库 PR 上的 `run-ci` 标签会启动质量检查。fork PR 不接受。
- 作业开始后删除该标签。删除失败时，只有标签已经不在，才算消费成功。
- push、普通 PR 同步、定时和 `workflow_dispatch` 都不进入这条质量流程。
- 同一 PR 的并发组是 `pr-quality-<编号>`，`cancel-in-progress` 为 false。新的请求排队，不取消已经开始的检查。
- 重跑使用 GitHub 的 Re-run，`run_attempt` 加一，待测提交仍是该次运行冻结的 SHA。
- 取消有两条路，互不代替：GitHub 上取消该次运行，或在群岛里中断本机 Worker。中断只杀本地进程树，不调用 GitHub 取消接口。
- 节点上跨仓库仍只有一个作业。租约由作业开始钩子获取，完成钩子在维护结束后释放。等待者取消或超时不能释放别人的租约。Worker 死亡后租约自行回收。

## 待测提交

`pull_request` 事件的 `github.sha` 是这次分发时的合并提交，运行创建后不再变化。检出必须使用这个 SHA，不能检出 `pull_request.head.sha`。PR 在排队期间继续推送，不会改掉已经开始或已经排队的那一次检查对象。

报告同时记下事件载荷里的 PR head，只作对照。正式检查的对象是 `github.sha`。工作区 `HEAD` 与它不一致时，结论是基础设施故障，不进入质量命令。

## 生命周期

顺序固定为：

1. 显式请求。脚本发现 `MINI_CI_REQUEST` 不是 `run-ci`，或事件不是 `labeled` / `run-ci` 时，直接退出，不写通过报告。
2. 固定提交。核对 `HEAD`。
3. 节点租约。GitHub Actions 上必须能在进程祖先里找到开始钩子写下的 owner。本地手动运行记为 `local`，不抢占节点租约。
4. 准备工作区。仓库若有 `ci/prepare-workspace.sh`，在这里执行。
5. 准备环境。按阶段选择工具链，再执行该阶段的 `prepare`。
6. 验收实际环境。工具链切换和虚拟环境激活之后，按该阶段的 `require` 测量真实命令、文件和凭据是否存在。
7. 执行检查。只有该阶段验收通过才运行 `check`。
8. 汇总与清理。阶段可以声明 `cleanup`，检查失败也会执行。

主机系统和架构在安装依赖之前核对。主机升级、系统授权不在作业里做。工具链版本不对或二进制不存在时，结论是环境失败，后面的 `check` 不运行。版本钉到次版本（例如 Node 26.12、Ruff 0.17、Rust 1.99），补丁号随已安装版本走。

多阶段项目逐段验收。任一段环境失败或检查失败后，后续阶段不再开始。已成功阶段保留在报告里。

## 环境覆盖

| 类别 | 谁负责 | 作业里怎么处理 |
| --- | --- | --- |
| 主机与系统 | 运维 | 核对 macOS 与 ARM64。不符合则环境失败 |
| 工具链 | 运维预装，作业按待测提交选择 | 在 `~/.local/share/mini-archipel/ci/toolchains`、`~/.local/ci-pinned` 或 `RUNNER_TOOL_CACHE` 中选择；当前 PATH 已是该版本时直接使用。作业不改系统包 |
| 项目依赖 | 仓库的 `prepare` | `pnpm install --frozen-lockfile`、`uv sync`、`make setup` 等，失败记为环境失败 |
| 执行上下文 | 共用脚本 | 每阶段独立的 `PATH` 和 `MINI_CI_ENV_ID`，不沿用上一阶段的虚拟环境 |
| 测试服务 | 仓库阶段 | 例如 Knowledge 在 prepare 里启动 Colima，验收 `docker info` 之后才构建 |
| 浏览器与图形 | 仓库阶段 | 在 prepare 安装、在验收里确认缓存。Flowbit 的浏览器仍在 `pnpm check:all` 内部，见矩阵 |
| 测试数据 | 仓库 | 随待测提交检出，不另造一份 |
| 网络 | 作业验收 | 需要外网的阶段在 `check` 前探测 |
| 凭据 | 运维与仓库密钥 | 只记录是否存在，报告不写值。标签消费用作业令牌 |
| 系统授权 | 运维 | 写入 `permissions` 声明。作业不探测辅助功能或屏幕录制，也不弹授权 |

## 结论

`schema` 为 1。最终结论只有一个：

| 值 | 含义 |
| --- | --- |
| `passed` | 全部阶段的环境验收和项目检查都通过 |
| `environment` | 环境不符合。正式质量命令没有跑，或在失败阶段之前停了 |
| `check` | 环境验收已通过，项目自己的检查失败。这不是质量通过 |
| `infrastructure` | 提交对不上、租约不在、工作区准备失败，或其他运行设施错误 |
| `interrupted` | 收到信号，或 Worker 已经退出而报告仍是未完成 |
| `incomplete` | 阶段还在进行 |

环境验收和项目检查分栏记录。`env_ok` 只在环境验收失败时为 false；项目检查失败时 `env_ok` 仍为 true。

## 报告与群岛

- 作业目录：`ci-report.json`、`ci-report.md`，随 artifact `quality-report-<attempt>` 上传。
- 节点：`~/.local/state/mini-archipel/ci/reports/<仓库目录>.json`，只保留该仓库在这台机器上的最近一次。
- 诊断：`~/.local/state/mini-archipel/ci/diagnostics/<仓库>-<运行编号>-<尝试>.log`。
- JSON 含仓库、PR、待测提交、请求者、运行编号、尝试次数、节点、共享实现版本、调度标签、主机事实、各阶段要求与实测、阶段状态、耗时、失败原因和诊断路径。

Runner 插件从节点报告读取当前阶段、环境验收和最近结论。GitHub 的 online/busy 仍来自仓库只读接口，本地 Listener/Worker 仍来自本机进程。三个来源不互相填空。Agent 重启后重新读磁盘上的报告；结论仍是 `incomplete` 且 Worker 已不在时，显示为中断。

## 共享实现与升级

共用流程在 mini-archipel：

- `.github/workflows/reusable-quality.yml`
- `.github/actions/quality/`

mini-archipel 自己的入口用仓库内相对路径，这样改共享流程的 PR 测到的就是这次提交。其他仓库的入口固定到 mini-archipel 的完整提交：

```yaml
uses: yaindrop/mini-archipel/.github/workflows/reusable-quality.yml@<40位提交>
```

升级就是把这个提交改成已经在 mini-archipel 验收过的新提交。不使用分支名。回退时把入口改回上一个提交，或恢复该仓库上一版自包含的 `pr-quality.yml`。节点钩子不跟着这条流程进退。

各仓库只保留薄入口、`ci/requirements.json`，以及自己的质量脚本。`check` 必须是仓库里本来就有的命令，例如 `pnpm check:all`、`pnpm check`、`make check`。

## 需求矩阵

| | Flowbit | flowbit-knowledge | in-frames | mini-archipel |
| --- | --- | --- | --- | --- |
| 质量入口 | `pnpm check:all` | `pnpm check`，然后镜像构建与 `pnpm test:deployment` | `make check` | provisioning 测试、fan-control、console（Node 26.12）、agent |
| 版本声明 | Node 26.12，pnpm 12.10，Rust 1.99，uv 0.13，Python 3.14；nightly rustfmt `nightly-2026-08-02` | Node 26.12，pnpm 12.10 | Node 26.12，pnpm 12.10，Python 3.14，uv 0.13 | Node 26.12，pnpm 12.10，Rust 1.99，uv 0.13，Python 3.14 |
| 节点标签 | `self-hosted, macOS, ARM64, ci` | 同上，另加 `container` | 同 Flowbit | 同 Flowbit |
| 服务 | 无 | Colima 与 Docker；虚拟机不接这个标签 | 无 | 无 |
| 浏览器 | 仍在 `pnpm check:all` 内 | 无单独门禁 | Chromium，在 `make check` 前安装并验收 | Chromium 与 WebKit，安装后验收 |
| 凭据 | `FLOWBIT_AGENT_UNLOCK_PASSWORD` 必须存在 | 无 | 无 | 标签消费用作业令牌 |
| 工作区 | `checkout-clean: false`，完整历史，`ci/prepare-workspace.sh` 保留可复用构建产物 | 默认干净检出 | 默认干净检出 | 默认干净检出 |
| 仍由项目保管 | `benchmark`、`core-regression`、`e2e-visual` 的手动入口；`run-sdk-platforms`；`pr-quality-check.yml` | 镜像标签和构建代理 | `make setup` 与 `.venv` | fan-control 不改硬件的脚本 |

受影响测试选择仍只是 Flowbit 的建议输出，不作为这套流程的门禁。

## 验收口径

- 没有 `run-ci` 时，质量命令不执行。
- 环境不符合时，该阶段的 `check` 不执行。
- 项目检查失败的结论是 `check`，不能记成通过。
- 并发不取消进行中的运行；租约不属于当前作业时不开始检查。
- 信号、Worker 消失后，报告或插件能落到中断，而不是一直未完成。
- 报告能指到提交、环境和失败阶段。
