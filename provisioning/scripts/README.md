# CI 群岛共享脚本

`ci-archipel.json` 是仓库和节点清单。每节点每仓库独立注册，安装在
`~/runners/<repo>`，不能复制 `.runner` 或认证私钥。

- `ci-lease.py`：同步开始钩子的跨仓库节点互斥；PID 和进程启动时间共同标识持有者。
- `ci-housekeeping.py`：只在持有节点租约的作业完成阶段维护可重建缓存。
- `job-started.sh`、`job-completed.sh`：四仓库共用的官方 Runner 钩子入口。
- `install-node-runners.py`：单节点安装器；存在 Worker 时退出 75，必须等空闲重试。

安装器在节点执行：

```sh
/usr/bin/python3 install-node-runners.py profile.json registration.json runner.tar.gz
```

`profile.json` 包含 `owner`、`node`、`kind`、`repositories` 和官方发布包 `sha256`。
`registration.json` 是仓库 slug 到新鲜注册令牌的映射，权限必须为 600；成功后删除。
先通过 GitHub Runner API 排空此节点的自定义调度标签，再安装；无论成功失败都恢复标签。
安装前先下载官方 macOS ARM64 包并核对 GitHub 发布摘要。私密配置和日志放仓库外，
不提交 token、认证文件或安装包。安装器保留原有注册，按官方 `svc.sh` 安装新服务，
备份环境与 plist 到 `~/.local/share/mini-archipel/ci/backups/`，不强杀 Worker。
中断后的未知安装目录需人工核对归属，不能覆盖或复制注册身份以“修复”。

固定 `.path` 继承当前已验收的基础工具链入口；各项目通过自己的锁文件与 workflow
选择版本，不改全局工具链默认值。代理使用节点自己的 `127.0.0.1:10808`。
钩子安装到 `~/.local/libexec/mini-archipel/ci/`，变更后先验证，再同步四节点；脚本更新用原子替换。
`.env` 变更必须等节点空闲后重启对应监听服务。

从 mini-archipel 仓库根目录验证：

```sh
python3 -m unittest discover -s provisioning/scripts/tests -v
cd provisioning && uv sync --locked --all-groups
uv run --no-sync ruff check scripts ../.github/actions/quality
uv run --no-sync ruff format --check scripts ../.github/actions/quality
shellcheck provisioning/scripts/*.sh
clang -Wall -Wextra provisioning/scripts/tests/hook-worker.c -o /tmp/Runner.Worker
/tmp/Runner.Worker
```

C 探针在真实 `Runner.Worker` 进程祖先下调用两个钩子，但清空工作区变量、
不执行维护或项目 CI。先确认节点空闲再运行探针，不在 Actions 作业内运行探针。验收必须分别报告注册在线、
钩子探针和真实项目 CI 三种证据；不能用探针替代项目检查通过。

## 群岛运维脚本

节点侧与宿主机侧的运维脚本同样由本目录维护，统一安装在
`~/.local/libexec/mini-archipel/`，配置在 `~/.config/mini-archipel/`，
数据在 `~/.local/share/mini-archipel/` 与 `~/.local/state/mini-archipel/`。

- `export-backup.py`：节点侧。导出本节点配置、二进制、Runner 凭据与
  Console 数据库（sqlite 在线备份），`openssl cms` 加密落到
  `~/.local/state/mini-archipel/backups/`，保留最近 14 份。加密证书为
  `~/.config/mini-archipel/recovery.crt`。
- `backup-archipel.py`：宿主机编排，`local.miniarchipel.backup` 每日 03:30
  触发。SSH 到四节点执行 `export-backup.py`，scp 拉回并核对 sha256 后落
  `~/.local/share/mini-archipel/backups/<node>/`，并推副本到 yd-mini-2 的
  `~/.local/state/mini-archipel/archipel-backups/`（各保留 14 份）。宿主自身
  脚本、配置、tart VM 定义与 LaunchAgent 打包加密为 `*-host-ops.tar.gz.cms`。
- `backup-signing.py`：加密持久签名身份，恢复材料同样进备份链。
- `host-services.py`：宿主机服务。`vms` 模式保活两台 tart 虚拟机并用
  caffeinate 维持宿主唤醒；`relay` 模式维持 SSH 本地转发，把宿主机局域网
  9102/9103 转发到客体内 `127.0.0.1:9101` 的 Agent。

`deploy/` 保存宿主机四个 LaunchAgent：`local.miniarchipel.vms`、
`local.miniarchipel.backup` 与两条 `local.miniarchipel.tunnel.*`。节点侧
export-backup 由宿主机经 SSH 触发，节点上无本地调度。备份恢复私钥
`recovery.key` 只在恢复时使用，不进入任何脚本路径。
