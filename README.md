# mini-fan-control

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
  失败。`src/` 与「上游 + 补丁」逐字节一致。

## 构建与安装

```bash
./build.sh            # Apple clang 21 / macOS 27 CommandLineTools 已验证
sudo ./install.sh     # 部署布局见下；不改 sudoers/SIP/FileVault/电源模式，无网络调用
```

上游自带的 `tests/` 面向其 Swift 菜单栏应用；C 守护进程的 mock-SMC 回归
 harness 未包含在本仓库，逻辑验证以实机验收数据为准（见 docs/）。

## 策略（config/fanctl.conf；校验和见 SHA256SUMS）

每秒读取 48 个 CPU/GPU 传感器取**最高值**决定档位：

| 温度（最高传感器） | 风扇目标转速 |
| --- | --- |
| < 37°C 持续 30 秒 | 交回 Apple 自动（约 1000 RPM） |
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
| 程序、配置、源码、补丁、许可 | `/Library/MacMiniFanControl/` |
| LaunchDaemon | `/Library/LaunchDaemons/com.macmini.fan-control.plist` |
| 服务标识 | `system/com.macmini.fan-control`（KeepAlive，异常退出自动重启） |
| 日志 | `/Library/Logs/MacMiniFanControl/control.log`（newsyslog 5×1 MiB） |
| 硬件自检 | `deploy/verify-hardware.py`（只读） |
| 停止并交回系统 | `sudo /Library/MacMiniFanControl/stop.sh` |

## 运维要点

```bash
# 只读状态（含 temp/peak/rpm/forced/level/down_delay）；显式 -c 最稳妥
/Library/MacMiniFanControl/fanctl -c /Library/MacMiniFanControl/fanctl.conf -j status
# Foundation 热状态：0 nominal / 1 fair / 2 serious / 3 critical
osascript -l JavaScript -e 'ObjC.import("Foundation"); $.NSProcessInfo.processInfo.thermalState;'
# 改参数：编辑 root 所有的 fanctl.conf 后重载（归还退出，launchd 重启）
sudo launchctl kill TERM system/com.macmini.fan-control
# 重载后必须核对【新 PID】与启动日志，不能只看 status 显示的参数
launchctl print system/com.macmini.fan-control | grep pid
tail -n 5 /Library/Logs/MacMiniFanControl/control.log
```

可靠性行为：连续 3 次读/写失败→交回系统并退出，launchd 自动重启；
TERM/INT 退出前交回系统。
