# CI 机群共享脚本

`ci-fleet.json` 是仓库和节点清单。每节点每仓库独立注册，安装在
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
备份环境与 plist 到 `~/.local/share/mini-ci/backups/`，不强杀 Worker。
中断后的未知安装目录需人工核对归属，不能覆盖或复制注册身份以“修复”。

固定 `.path` 继承当前已验收的基础工具链入口；各项目通过自己的锁文件与 workflow
选择版本，不改全局工具链默认值。代理使用节点自己的 `127.0.0.1:10808`。
钩子安装到 `~/.local/libexec/mini-ci/`，变更后先验证，再同步四节点；脚本更新用原子替换。
`.env` 变更必须等节点空闲后重启对应监听服务。

从 mini-archipel 仓库根目录验证：

```sh
python3 -m unittest discover -s provisioning/scripts/tests -v
uvx 'ruff>=0.17,<0.18' check --select E,F,I provisioning/scripts
uvx 'ruff>=0.17,<0.18' format --check provisioning/scripts
shellcheck provisioning/scripts/*.sh
clang -Wall -Wextra provisioning/scripts/tests/hook-worker.c -o /tmp/Runner.Worker
/tmp/Runner.Worker
```

C 探针在真实 `Runner.Worker` 进程祖先下调用两个钩子，但清空工作区变量、
不执行维护或项目 CI。先确认节点空闲再运行探针，不在 Actions 作业内运行探针。验收必须分别报告注册在线、
钩子探针和真实项目 CI 三种证据；不能用探针替代项目检查通过。
