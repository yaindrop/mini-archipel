# 风扇控制插件

本目录是 [mini-archipel](../README.md) 的第二款插件，提供可视化曲线、实时传感器、限时控制、校准、自检及诊断。完整功能、权限边界和运维设计见 [插件设计](docs/plugin.md)。源码、构建、安装和实机记录
统一在此维护。原独立仓库的完整提交历史已并入；装机步骤见
[provisioning 第 9 章](../provisioning/docs/09-fan-control.md)。

基础款 Apple M6 Mac mini（Mac18,5）的自适应风扇控制守护进程：空闲安静、
负载升温时提前散热、降温带独立滞回、低温交还 Apple 自动控制。

## 来源与许可

- 上游：[beomwookang/macos-fan-control](https://github.com/beomwookang/macos-fan-control)，
  固定提交 `2ed80b5a94bc894c7b43f0b4e57091c5e6d05aa4`，MIT（见 LICENSE）。
**工具选型**：商业工具与其他开源候选的评估见
[docs/tool-selection-20261015.md](docs/tool-selection-20261015.md)。
- 本机适配：`patches/m6.patch`（仅改 `src/fanctl.c`）——M6 小写模式键
  `F0md` 回退、永不探测/写入 force 模式下的最低转速键、模式写入确认后才写
  目标、传感器容量 64、48 个显式核对的 Te/Tp/Tg 键、缺失选中传感器即采样
  失败。
- 群岛插件扩展：`patches/archipel.patch`，记录真实循环状态、force-only 自检、结构化诊断和校准保护。`check-source.sh` 在临时目录逆向两层补丁并核对固定上游摘要。

## 构建与安装

```bash
cd fan-control       # 从 mini-archipel 仓库根目录进入
./build.sh            # Apple clang 21 / macOS 27 CommandLineTools 已验证
./test.sh             # mock SMC、真实文件/进程和 IPC 的隔离测试
sudo ./install-plugin.sh "$(id -un)" # 备份并安装，不改 sudoers/SIP，无网络调用
```

测试不链接真实 AppleSMC，不在 CI 上修改风扇或运行负载校准。

## 策略（config/fanctl.conf；校验和见 SHA256SUMS）

每秒读取 48 个 CPU/GPU 传感器取**最高值**决定档位：

| 温度（最高传感器） | 风扇目标转速 |
| --- | --- |
| < 37°C 持续 30 秒 | 交回 Apple 自动（可为 0 或约 1000 RPM） |
| ≥ 40°C | 2170 RPM |
| ≥ 50°C | 2950 RPM |
| ≥ 60°C | 3730 RPM |
| ≥ 70°C | 4900 RPM（`critical_temp` 满速线） |

- 升档：**立即**（`up_delay = 0`，下一次 ≤1s 采样生效；实测负载 4 秒内 1→4 档）。
- 降档：低于该档边界 **3°C 连续 30 秒**（`hysteresis = 3`、`down_delay = 30`）；
  每道边界独立计时，快速冷却时可连续降档。
- 转速百分比按 `1000 + (4900-1000) × 比例` 计算。
- 备选参数：`config/fanctl.conf.down20`（20 秒降档等待版本）。

实测基线与验收数据见 [docs/measurements-20261016.md](docs/measurements-20261016.md)。

## 部署布局

| 内容 | 路径 |
| --- | --- |
| 程序、配置、源码、补丁、许可 | `/Library/MiniArchipel/FanControl/` |
| LaunchDaemon | `/Library/LaunchDaemons/local.miniarchipel.fanctl.plist` |
| 服务标识 | `system/local.miniarchipel.fanctl`（KeepAlive，异常退出自动重启） |
| 日志 | `/Library/Logs/MiniArchipel/fan-control.log`（newsyslog 5×1 MiB） |
| 硬件自检 | `deploy/verify-hardware.py`（需 root；四档实写 / 回读，结束恢复 Apple 自动控制） |
| 停止并交回系统 | `sudo /Library/MiniArchipel/FanControl/stop.sh` |

## 运维要点

```bash
# 只读状态（含 temp/peak/rpm/forced/level/down_delay）；显式 -c 最稳妥
/Library/MiniArchipel/FanControl/fanctl -c /Library/MiniArchipel/FanControl/fanctl.conf -j status
# Foundation 热状态：0 nominal / 1 fair / 2 serious / 3 critical
osascript -l JavaScript -e 'ObjC.import("Foundation"); $.NSProcessInfo.processInfo.thermalState;'
# 改参数：编辑 root 所有的 fanctl.conf 后重载（归还退出，launchd 重启）
sudo launchctl kill TERM system/local.miniarchipel.fanctl
# 重载后必须核对【新 PID】与启动日志，不能只看 status 显示的参数
launchctl print system/local.miniarchipel.fanctl | grep pid
tail -n 5 /Library/Logs/MiniArchipel/fan-control.log
```

可靠性行为：连续 3 次读/写失败→交回系统并退出，launchd 自动重启；
TERM/INT 退出前交回系统。

仓库的主动 `PR Quality` 检查校验文件摘要、补丁、脚本语法并构建程序，不安装服务或写 SMC。
虚拟机只参与编译和静态检查，不运行硬件验证。
