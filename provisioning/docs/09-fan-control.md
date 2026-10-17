# 9. 自适应风扇控制

仅适用于有受支持 SMC 硬件的实体 Mac mini。Tart 客体没有独立风扇与 SMC，
不安装、不伪造读数、不执行写入验证；由宿主机负责散热，客体记为“不适用”。

部署本仓库的 [fan-control](../../fan-control/README.md)
模块（SMC 守护进程）：空闲安静、负载提前散热、每道降档
边界独立 3°C/30 秒滞回、低于 37°C 交回 Apple 自动。

## 安装（一次 sudo）

```sh
git clone https://github.com/yaindrop/mini-archipel
cd mini-archipel/fan-control
./build.sh                 # Apple clang + CLT 即可，零警告编译
sudo ./install.sh          # 构建核对→停旧实例→安装→四档实写验证→启动守护
```

`install.sh` 会在**启动守护进程之前**执行四档风扇实写验证（2170/2950/
3730/4900 RPM 目标与实际读回，±150 RPM 内），随后交回 Apple 自动再启动
守护进程。实测两台 M6 读回偏差均 <2%。

## 策略速览

| 温度（48 传感器最高值） | 目标转速                  |
| ----------------------- | ------------------------- |
| < 37°C 持续 30s         | Apple 自动（0–1000 RPM）  |
| ≥40 / ≥50 / ≥60 / ≥70°C | 2170 / 2950 / 3730 / 4900 |

2026-10-18 核对两台实体机：程序摘要、去除注释后的有效配置、48 个传感器和
升降档参数均一致。33.6–33.7°C 时两台均 `forced=false / level=0`，实际转速分别约
1000 RPM 和 0 RPM，来自上述 Apple 自动分支。该策略保证控制规则一致，不保证
两台 SMC 的瞬时待机转速相同；本轮没有更改温控策略或写入风扇控制值。

升档立即（实测负载 4 秒内 1→4 档）；约 10 分钟满载全程 4 档、峰值 84–86°C、
热状态 nominal；负载结束按各边界滞回级联回落（实测 23–98 秒交还系统）。

## 运维

```sh
/Library/MacMiniFanControl/fanctl -j status          # 只读状态
sudo launchctl kill TERM system/com.macmini.fan-control   # 改配置后重载
launchctl print system/com.macmini.fan-control | grep pid # 必须核对【新 PID】
```

## 实战教训

1. **验证器与守护进程会打架**：守护进程每秒轮询，低温时每拍交回 Apple
   自动，会覆盖一次性 `fanctl force` 写入。四档验证必须在守护进程停止时
   做（install.sh 已按此排序）。
2. **改配置后不能只看 status 参数**：daemon 靠 SIGHUP/重启生效，必须核对
   新 PID 与启动日志行（`delay=0/30s` 等）。
3. **重启/睡眠恢复要专项验收**：launchd 自启新实例、传感器读取、控制日志
   零失败、负载行为与基线一致——两台均按此验收通过。
4. 每秒采样用 `fanctl -j status` 轮询即可（只读、无需 sudo），足以支撑
   升档速度/滞回/回落时长/反转次数的量化对照。
