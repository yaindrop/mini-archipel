# 2. 电源、FileVault 与登录会话

## 实体机电源基线（无外设常开）

| 设置                     | 值      | 核对                     |
| ------------------------ | ------- | ------------------------ |
| 接入电源时自动启动       | 始终    | `autorestartatconnect 1` |
| 防止显示器关闭时自动睡眠 | 开启    | `sleep 0`                |
| 显示器休眠               | 10 分钟 | `displaysleep 10`        |
| 唤醒以供网络访问         | 开启    | `womp 1`                 |

```sh
sudo pmset -a sleep 0 displaysleep 10 womp 1 autorestartatconnect 1
pmset -g custom
```

Tart 客体只需防睡眠与显示器休眠配置：`sleep 0`、`displaysleep 10`。
客体没有独立的电源按钮、网卡唤醒和接电启动能力，不要求出现 `womp` 或
`autorestartatconnect`。宿主机休眠、注销或退出 Tart 会影响所有客体。

## 四个彼此独立的启动阶段

接电自动开机 → FileVault 磁盘解锁 → 桌面登录 → 用户服务启动，是四个不同
阶段：

- **实体机 FileVault 保持开启**，不设自动登录、免密 sudo。
- 重启前安排好磁盘解锁；普通屏幕共享不等于 FileVault 解锁通道。
  Apple silicon 的 macOS 26 及以后可在满足远程登录和联网条件时通过 SSH
  解锁，但必须在目标机实测，不能由“SSH 开关已开”推断重启必能恢复。
- runner 与后台代理是**用户级 LaunchAgent**：需要桌面登录会话才运行；锁屏
  不影响，注销会停。日常保持桌面账户登录、离开锁屏。
- 重启前先停止 CI 接单并等现有作业结束。

## Tart 客体豁免

- 不要求客体启用 FileVault；宿主机必须开启 FileVault，镜像与备份放在受保护存储中。
- 允许运维账户自动登录、免密 sudo，方便客体恢复与 CI 安装依赖。
- 自动登录只解决客体的桌面会话，不会自动启动宿主机上的 Tart。
- 验收按“宿主机解锁并登录 → Tart 启动 → 客体登录 → 代理与 runner 在线”
  分段记录；未重启验证时直接注明，不能只凭 `RunAtLoad` 认定通过。

参考：[Apple：管理 FileVault](https://support.apple.com/en-ca/guide/security/sec8447f5049/web)。

## 经验

- 注销后 `audiomxd`、`configd` 会持续高 CPU；保持桌面登录即可。
- 关闭"登录时恢复窗口"（`TALLogoutSavesState=false`），重启不重开窗口。
