# 8. 自托管 GitHub Actions runner

## 注册与服务

1. 从 GitHub 官方 actions/runner 发布包安装 macOS ARM64 版，核对发布摘要；
   不禁用 runner 自动更新。
2. 安装目录 `~/github-runners/<repo>`（每仓库一个目录，为多仓库多 runner
   预留），工作目录 `_work`；每台每仓库一个正式 runner。后续仓库装在
   `~/github-runners/<repo2>`，互不干扰。
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
7. 标签按调度需要：`self-hosted, macOS, ARM64` + 机器角色标签。

**坑：`config.sh --help` 也会执行 env.sh 并覆盖 `.path`**——别拿它当
无副作用检查；每次配置/注册后复核固定 PATH。

仓库改名后使用 GitHub 的正式名称注册（当前为 `yaindrop/flowbit`）；网页/API
重定向成功不代表旧名称仍能完成 runner 注册。现行服务标签统一为
`actions.runner.yaindrop-flowbit.<runner-name>`，不保留旧名服务。
启停工具仍应读取安装目录的 `.service`，由注册信息定位实际服务，避免写死名称。

## 作业完成钩子（自动维护）

设置 `ACTIONS_RUNNER_HOOK_JOB_COMPLETED` 指向维护脚本，每次作业结束后：

| 对象                | 规则                                                                        |
| ------------------- | --------------------------------------------------------------------------- |
| runner `_diag` 日志 | 14 天/256 MiB 上限，保留当前与最近 5 个                                     |
| pnpm/uv 缓存        | 每 7 天尝试官方 prune                                                       |
| Rust `target`       | 总预算 32 GiB，优先清 7 天未动的可重建缓存                                  |
| SSD 余量            | <40 GB 时可回收热 target                                                    |
| 保护                | 只碰 gitignore 排除、无跟踪文件、非软链接的 target；不动源码与 node_modules |
| 执行                | 互斥锁、90 秒总限时、单命令超时；有活跃 Worker 时手动调用会退出             |
| 失败                | 记 warning，不改变 CI 成败；无常驻清理守护                                  |

工作区使用 `GITHUB_WORKSPACE`，不要写死历史 `_work/flow-bit/flow-bit`。
当前维护历史写 `~/.local/state/flowbit-ci-housekeeping/history.jsonl`。用真实
Actions 作业验收钩子，并确认最终 `complete`、无 warning。

## 多机策略

- 同一 runner 同时只执行一个作业；沿用仓库侧的并发/矩阵约束。
- 共同标签：`self-hosted, macOS, ARM64, flowbit-primary, flowbit-ci, flowbit-lint`。
  实体机增加 `physical, flowbit-container`（必须先完成容器验收）；Tart 增加
  `tart`，不添加容器标签。需要本机容器的任务要求 `flowbit-container`，
  不使用某台机器的历史专用标签。
- 备用机停用：`launchctl disable` + `bootout`（重启不自动接单），安装与
  注册保留。恢复：

```sh
label="actions.runner.<owner>-<repo>.<runner-name>"
domain="gui/$(id -u)"
launchctl enable "$domain/$label"
launchctl bootstrap "$domain" "$HOME/Library/LaunchAgents/$label.plist"
```

## 目录迁移（svc.sh 官方流程）

```sh
cd ~/github-runners/<repo>
./svc.sh uninstall          # 停服务、移除 LaunchAgent（注册与 _work 保留）
mkdir -p ~/github-runners && mv <旧目录> ~/github-runners/<repo>
./svc.sh install            # 从新路径重新生成 LaunchAgent 并启动
```

迁移后做三件事：

1. 改引用：`.env` 里的绝对路径，以及一切硬编码 runner 目录的辅助脚本——
   作业完成钩子（`_work`、`_diag`）、代理切换助手（探测 `Runner.Worker` 是否
   活跃，路径过期会误判空闲、在作业中途切节点）等。用
   `grep -rl <旧目录> ~/.local/bin ~/Library/LaunchAgents` 兜底排查。
2. **清掉烙有旧绝对路径的构建产物**——目录移动不会让工具链自愈这一类：

   - Python venv：`.venv/bin/*` 的 shebang 指向旧路径，表现为
     `Failed to spawn: mypy/pyinstaller/...`。删除工作区内所有 `.venv`
     （`uv sync` 会带新 shebang 重建）。
   - Rust `target`：`env!("CARGO_MANIFEST_DIR")` 在编译期烙入路径，cargo
     不因目录移动重编，表现为测试拿死路径找 fixture。删除工作区内全部
     `target` 目录，强制一次重编译（一次性成本，实测清空后首轮全量重编，
     之后回归正常）。

   ```sh
   cd ~/github-runners/<repo>/_work/<repo>/<repo>
   find packages -maxdepth 6 -name .venv -not -path "*/node_modules/*" -exec rm -rf {} +
   find . -maxdepth 3 -name target -type d -not -path "*/node_modules/*" -exec rm -rf {} +
   ```

3. 跑一轮完整 CI 验收：全部检查通过、作业完成钩子在新路径留痕，即迁移
   完成。异常中断的运行可能在扫描型检查处留下临时探针文件（表现为下一轮
   布局/治理检查报陌生文件），确认未跟踪后删除即可。

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

Console 在 `plugins.runners` 下设置 `enabled: true`，可选的远端连接使用 `options.repositories` 数组，每项为 `{ "repo": "owner/repo", "token": "<仓库 token>" }`。仓库连接独立管理，不再使用单仓库 `githubRepo` / `githubToken`、顶层 GitHub 配置、全局 Runner 控制环境变量或旧的 Runner 专用接口。具体接口及初始化命令见 mini-archipel 的 `docs/plugins.md`。

一台节点可安装多个 Repo 的 Runner，每个实例使用独立的 `~/github-runners/<安装目录>` 和注册服务。群岛从 `.runner` 的 `gitHubUrl` 自动识别完整仓库标识，在 **Runners → Repo → 各节点 Runner** 下管理；新增仓库不需要手动添加监控目标。不同 owner 的同名仓库使用不同安装目录。启停同时校验仓库和安装目录，不用 Runner 名称模糊匹配。当前协议为 Runner 插件 v2，Console 0.5.0 / Agent 0.3.0。

群岛的节点清单将类型和身份分开记录：`hosts[].kind` 只允许 `physical`（物理机）或 `virtual`（虚拟机）；`identity` 记录设备及运行环境。两台 mini 的身份统一为 `M6 Mac Mini`，两台虚拟机统一为 `Tart on M4 Max MacBook`。身份描述不增加类型，也不改变历史数据的节点键；离线时仍保留这两项记录。

日常在“插件管理”分别控制控制台与四台节点，开关即时生效并保存。禁用监控插件只停止采集与该插件的操作能力，不停接单服务、不终止 Worker；只有插件中的“停止接单”会改变 CI 服务，执行前检查真实 Worker。实体机和 Tart 使用相同插件规则。

验收时切换每个节点的插件开关，确认核心采集保持在线、其他节点不受影响、Runner 进程不变，并核对重启 Agent 用户服务后开关恢复。此项不替代机器重启或真实 CI 作业验收。
