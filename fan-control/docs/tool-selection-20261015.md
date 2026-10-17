# 工具选型与首部署调查（2026-10-15/16）

目标：空闲低速、负载升温提前增风、降速带温差滞回、低温交回系统。调查对象
为基础款 M6 Mac mini（Mac18,5，macOS 27.0.1）。本文是当时选型与首部署的
记录；当前策略与数据以 README 与 measurements 文档为准。

## 官方电源设置的边界

Apple 的 High Power Mode 通过允许更高风速改善部分重负载性能，但 Mac mini
只支持 Pro 芯片型号；基础款 M6 不在支持范围。可保持 Automatic、关闭
Low Power Mode；未找到 Apple 为基础款 M6 提供的锁最高频率设置。空闲降频
属于正常节能，验收看真实负载下的持续频率和任务耗时。
依据：[Apple Power Modes](https://support.apple.com/en-ie/101613)。

## 商业工具评估

| 工具                    | M6 / macOS 27 证据                                                | 自适应能力                                                                   | 使用限制                                                     |
| ----------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------ |
| TG Pro 2.104            | 厂商版本说明明确列出 M6 Mac mini 和 macOS 27                      | 多条温度规则，可选最高 CPU、平均 CPU、具体传感器；同时触发时采用最高风速要求 | Apple Silicon 的阶梯 Auto Boost 需要完整接管风扇，见下文     |
| Macs Fan Control 1.5.22 | 2026-10-13 正式版新增 M6 Mac mini，并修复 macOS 27 缺失温度传感器 | 选择一个温度传感器，配置开始升速温度与上限温度                               | 官方界面未提供同一风扇的多传感器取最高或多点曲线功能 |

兼容性来源：[TG Pro release notes](https://www.tunabellysoftware.com/tgpro/releasenotes/)、
[Macs Fan Control release notes](https://crystalidea.com/macs-fan-control/release-notes)。
规则来源：[TG Pro user guide](https://www.tunabellysoftware.com/support/tgpro_tutorial/)、
[Macs Fan Control 官方界面文本](https://github.com/crystalidea/macs-fan-control/blob/master/languages/English.xml)。

Macs Fan Control 的“不能控制 M6”旧报告针对 1.5.21；原报告者已在 2026-10-10
确认 1.5.22 预发布版能控制 M6 风速。
来源：[厂商 issue #915](https://github.com/crystalidea.com/macs-fan-control/issues/915)。

### “只提高系统风速”的重要区别

TG Pro 在 Apple Silicon 上默认提供 System / Max / Auto Max；Auto Max 的规则
触发风速统一为 100%。启用阶梯 Auto Boost 可以设置多档风速，但会完整接管
风扇。文档里的 CPU Throttle Fix 仅限 Intel。
来源：[TG Pro 的 Apple Silicon 控制说明](https://www.tunabellysoftware.com/support/tgpro_tutorial/)。

TG Pro 公开了规则切换的渐变用时（1–120 秒）；未查到分别配置升速/降速延迟
或温度滞回区间的公开选项，渐变用时不能等同于滞回控制。
来源：[部署配置](https://www.tunabellysoftware.com/support/remotely_deploy_tg_pro.php)。

### 登录、自启动和退出

- TG Pro 官方部署配置 `launchOnLogin` 是用户登录后启动；官方资料没有保证
  特权 helper 单独在无人登录时继续执行温度规则。
- Macs Fan Control 的“开机后、登录前启动”仍是开放功能请求
  （[厂商 issue #2](https://github.com/crystalidea/macs-fan-control/issues/2)）。
- 正常退出后两者均声明归还系统控制；这不足以证明进程被强杀或卡死时的回退。
  来源：[TG Pro FAQ](https://www.tunabellysoftware.com/support/faq/)。

结论：两款商业工具都无法同时满足「低温交回系统」与「独立降速滞回」，实际
试用 TG Pro 2.104 后确认其配置资源只有 1–120 秒 Gradual Time，故改用开源
fanctl 方案；TG Pro 应用已退出并关闭登录自启，helper 未安装。

## 其他开源候选

[fanpro](https://github.com/omar16100/fanpro)：官方硬件表只有 M3 Ultra 完整
验证；心跳线程请求主循环归还风扇，主循环卡在 SMC 调用内时线程不能自行完成
归还（[实现](https://github.com/omar16100/fanpro/blob/c312596f8ab086bb8aadd7640b7a945911e61e1c/src/daemon/heartbeat.c)）。

[M6 专用控制器](https://github.com/HDZucht/Mac-mini-M6-fan-control-LLM)：只将
接管瞬间的实际风速保存为下限，不保证始终不低于 Apple 动态需求；写入失败
仍更新已发送目标，且没有独立心跳回退
（[实现](https://github.com/HDZucht/Mac-mini-M6-fan-control-LLM/blob/1ed1d62cd5169a337c30e8e31b89e3115ff1e59e/fanguard.c)）。

因此选择 [fanctl 上游](https://github.com/beomwookang/macos-fan-control)
（固定提交 `2ed80b5a`，MIT）加本仓库的 `patches/m6.patch`。

## 首部署验收记录（2026-10-15/16）

策略输入为本机 48 个 Te/Tp/Tg CPU/GPU 传感器的最高值，每秒采样。初版参数
为 20 秒降速等待（2026-10-16 调整为 30 秒，对照数据见 measurements 文档）：

| 升温阈值  | 控制方式       | 目标转速           |
| --------- | -------------- | ------------------ |
| 低于 40°C | Apple 自动控制 | 由系统决定，可停转 |
| 达到 40°C | 30%            | 2170 RPM           |
| 达到 50°C | 50%            | 2950 RPM           |
| 达到 60°C | 70%            | 3730 RPM           |
| 达到 70°C | 100%           | 4900 RPM           |

百分比定义 `1000 + (4900 - 1000) × 比例`；升温立即，降温按各阈值独立
3°C/等待时间滞回。

验收：ASan/UBSan 模拟 SMC 测试覆盖升温边界、各降温边界等待、温度反弹、
跨档降温、采样长间隔、多传感器取最高、缺失传感器、M6 模式键、归还系统与
失败回退；实机四档转速 2193/2936/3678/4833 RPM 对应目标 2170/2950/3730/
4900 RPM 通过。4 进程短时负载验证：44.2°C 升 2170 RPM，72.7°C 请求 4900
RPM 并实际达到；停止负载后按滞回逐档回落并交还系统。同期 IOReport 采样
负载阶段 P/S 核 4748–4788 MHz、CPU 功耗约 26 W。随后一轮约 11.5 分钟的
完整构建与测试负载期间热状态全程 nominal，采到的最高温度 84.5°C，负载采样
仍可达 P/S 核 4788 MHz，整轮后交还 Apple 自动控制。

## 本机异常事件背景

部署前本机出现过风扇实际/目标均为 0、热状态 critical、负载下 E 核
972 MHz、P/S 核 1440 MHz 的异常组合。正常重启后恢复约 1000 RPM 自动风速、
nominal 热状态，负载可达 E 核 2940 MHz、P/S 核 4788 MHz。证据支持电源/SMC
状态异常方向，未复现最初触发条件；风扇曲线优化减少正常工作积热，与该异常
的根因是两回事。
