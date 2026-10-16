# 8. 自托管 GitHub Actions runner

## 注册与服务

1. 从 GitHub 官方 actions/runner 发布包安装 macOS ARM64 版，核对发布摘要；
   不禁用 runner 自动更新。
2. 安装目录 `~/github-runners/<repo>`（每仓库一个目录，为多仓库多 runner
   预留），工作目录 `_work`；每台每仓库一个正式 runner。后续仓库装在
   `~/github-runners/<repo2>`，互不干扰。
3. 各机独立注册加入目标仓库 `<owner>/<repo>`——**绝不复制旧机的
   `.runner`、`.credentials` 或私钥**；注册令牌一次性使用。
4. 安装用户级 LaunchAgent：RunAtLoad、KeepAlive、10 秒重启节流。
5. 固定 `.path`（工具链顺序）与 `.env`；注册信息与 env 文件权限 600。
6. `.env` 建议：`ELECTRON_GET_USE_PROXY=1`（Electron 下载走代理）、按项目
   需要固定构建开关（如 `VITE_MKCERT_ENABLED=0`），以及 Corepack 防漂移项
   `COREPACK_DEFAULT_TO_LATEST=0`、`COREPACK_ENABLE_AUTO_PIN=0`、
   `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`。
7. 标签按调度需要：`self-hosted, macOS, ARM64` + 机器角色标签。

**坑：`config.sh --help` 也会执行 env.sh 并覆盖 `.path`**——别拿它当
无副作用检查；每次配置/注册后复核固定 PATH。

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

维护历史写 `~/.local/state/ci-housekeeping/history.jsonl`。用真实 Actions
作业验收钩子。

## 多机策略

- 同一 runner 同时只执行一个作业；沿用仓库侧的并发/矩阵约束。
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

1. 改引用：`.env` 里的绝对路径，以及一切硬编码 runner 目录的辅助脚本——\ 作业完成钩子（`_work`、`_diag`）、代理切换助手（探测 `Runner.Worker` 是否
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
