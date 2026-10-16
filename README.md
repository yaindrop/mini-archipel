# mac-mini-provisioning

把一台新 Mac mini（Apple Silicon）配成**无外设 CI 机**的完整实战手册：只接
电源和网线/Wi-Fi，日常 SSH 管理、屏幕共享备用，跑自托管 CI；空闲安静、
负载积极散热、磁盘与后台可控。

内容来自两台基础款 M6 Mac mini（16 GiB / 245 GB SSD，macOS 27）的实际部署
与验收记录（2026-09 至 2026-10），含走过的弯路和明确不做的尝试。

配套仓库：[mac-mini-fan-control](https://github.com/yaindrop/mac-mini-fan-control)
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

## 两台机器的最终形态（示例名）

| 项目      | mini-1（主力）         | mini-2（备用）         |
| --------- | ---------------------- | ---------------------- |
| 硬件      | M6，16 GiB，245 GB SSD | 同                     |
| 系统      | macOS 27.0.1           | 同                     |
| CI 接单   | 在线                   | 停用（注册与环境保留） |
| 风扇控制  | 已部署，30s 降档滞回   | 已部署，同策略         |
| Docker    | CLI + Colima 按需启动  | 同                     |
| FileVault | 开启                   | 开启                   |

## 标识与路径约定

手册中的名称均为示例，部署时替换为自己的：

| 示例                      | 实际含义                              |
| ------------------------- | ------------------------------------- |
| `mini-1` / `mini-2`       | 各机短用户名、主机名与 SSH 别名       |
| `<owner>/<repo>`          | CI 目标仓库                           |
| `~/github-runners/<repo>` | runner 安装目录（每仓库一个）         |
| `~/.local/ci-pinned/bin`  | 项目固定工具链入口（优先于 Homebrew） |
| `com.example.ci-proxy`    | 独立 CI 代理 LaunchAgent 标识         |
| `192.168.<subnet>`        | 自己的局域网网段                      |

账户密码、SSH 私钥、代理节点凭据、runner 注册令牌**不写入任何文档，不从
旧机整套复制到新机**；每台机器独立生成身份。
