# 2. 电源、FileVault 与登录会话

## 电源基线（无外设常开）

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

## 四个彼此独立的启动阶段

接电自动开机 → FileVault 磁盘解锁 → 桌面登录 → 用户服务启动，是四个不同
阶段：

- **FileVault 保持开启**，不设自动登录、免密 sudo。
- 开机前的磁盘解锁需要人在场（或屏幕共享）输入密码；重启前先安排好解锁。
- runner 与后台代理是**用户级 LaunchAgent**：需要桌面登录会话才运行；锁屏
  不影响，注销会停。日常保持桌面账户登录、离开锁屏。
- 重启前先停止 CI 接单并等现有作业结束。

## 经验

- 注销后 `audiomxd`、`configd` 会持续高 CPU；保持桌面登录即可。
- 关闭"登录时恢复窗口"（`TALLogoutSavesState=false`），重启不重开窗口。
