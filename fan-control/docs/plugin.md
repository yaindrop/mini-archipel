# 风扇控制插件

## 功能与实现

群岛第二款插件，独立于 Runners。主导航位于 Runners 下方；节点概览中的简要状态位于 Runners 前，节点专页提供完整编辑器。虚拟机明确显示无硬件风扇。

| 原有命令 | 工作台入口 | 执行与恢复 |
| --- | --- | --- |
| status / temps | 实时温控、全部传感器与风扇 | 读取真实 SMC 和守护进程状态 |
| daemon | 曲线编辑、响应参数、服务控制 | 阶梯图、数值编辑、导入导出、版本回退 |
| pause / resume / auto | 系统自动、曲线控制 | 不重启 Agent；明确保留暂停模式 |
| force | 限时控制 | 5–900 秒本地租约，取消或到期恢复 |
| selftest | 风扇自检 | 所选风扇逐档实写、回读实际转速，始终恢复 |
| calibrate | 实测校准 | 全核 CPU 负载，温度保护，可取消；建议只进草稿 |
| calibrate -n | 校准试运行 | 仍产生 CPU 负载；不写风扇、不生成实测建议 |
| daemon -n | 只读模拟 | 有限时长，不写硬件 |
| dump / keyinfo | SMC 读取诊断 | 固定命令、受限输入、任务日志 |
| trywrite | 管理员授权的写入诊断 | 仅允许配置白名单中的风扇键，写前核对旧值，结束恢复 |

当前硬件适配器支持 `Mac18,5`，只支持 force 模式、显式传感器、零升档延迟。不会把旧 CLI 的 floor 或自动枚举选项伪装为可用功能。原生 CLI 保留，但网页不提供任意 SMC 写入能力。

默认曲线维持原配置：0/1000、40/2170、50/2950、60/3730、70/4900，48 个明确验证的传感器，3°C 滞回、30 秒独立降档等待。基础档交还 Apple 自动控制，故两台机器在相同空闲策略下仍可能分别为 0 与 1000 RPM。明确的限时固定转速允许指定 1000 RPM，不改变默认温控策略。

## 权限和故障边界

`control.py` 由独立 root LaunchDaemon 运行，通过 Unix socket 向指定 Agent 账户提供三个操作：读取、提交任务、取消。每个连接检查 `getpeereid`；不开放 root HTTP，不添加 sudoers，不让 Agent 以 root 运行。socket 为 root/Agent 组 0660，父目录明确设为 0755；必须在服务的 umask 077 下测试。重装和回滚都等待旧 launchd 作业及进程完全退出，再有界重试 bootstrap；安装健康检查以普通 Agent 账户执行。

调用链为：工作台认证及同源检查 → 插件 Console action → 带 token 的节点 Agent → 本地 socket → 固定路径的 fanctl。核心只注册插件，不按插件名称分支。

每台节点一次只执行一个任务。请求 UUID 幂等，策略摘要用于并发比较；任务、阶段、结果、回退版本和审计事件保存在 root 所有的 JSON 文件。页面关闭、刷新或 Agent 重启不会移除任务。有限时长操作由节点独立计时。子进程可取消，先 TERM，再有界 KILL 并回收；helper 的 launchd 进程组会在异常退出时清理诊断子进程。

温度失读、过期或达到保护线停止硬件测试和手动租约。清理必须先恢复硬件，不能依赖写盘成功；磁盘满和部分暂停失败均有回归测试。helper 重启会回退未确认的配置并恢复中断任务。损坏任务日志先恢复控制，再归档损坏文件。

保存曲线先严格验证、记录旧版本、原子替换，随后重载。守护进程报告配置文件的 inode、纳秒时间戳、大小和实际循环状态，helper 确认同一版本才发布成功；失败恢复原文件。`status` 推断的档位不用于声称实时循环已执行。

关闭插件仅关闭监控与操作入口，不停止独立温控。管理员可随时从节点本地恢复系统控制。诊断日志只保留有界内容，不收集 Runner 凭据或 GitHub token。

## 安装和配置

```bash
cd fan-control
./build.sh
./test.sh
sudo ./install-plugin.sh "$(id -un)"
```

安装只复制已由用户构建的程序，备份旧配置和服务；不在 root 下构建，不自动运行硬件自检或 CPU 校准。安装失败回退已有备份。`install.sh` 保留为相同安装入口。

Agent 配置：

```toml
[plugins.fan-control]
enabled = true
[plugins.fan-control.options]
interval_ms = 2000
allow_control = true
```

不设置 `allow_control` 时默认为只读。Console 配置增加 `"fan-control": { "enabled": true, "options": {} }`。使用既有插件开关控制各节点采集和工作台可见性。语言、主题复用群岛的系统默认三态设置；草稿按节点保存在浏览器，实时更新不覆盖编辑；版本冲突需要用户比较处理。

| 内容 | 路径 |
| --- | --- |
| 本地 authority | `/Library/MacMiniFanControl/control.py` |
| authority 服务 | `system/local.miniarchipel.fan-control` |
| root 设置 | `/Library/MiniArchipel/FanControl/control.json` |
| IPC | `/var/run/mini-archipel/fan-control.sock` |
| 持久任务和版本 | `/Library/Application Support/MiniArchipel/FanControl/state.json` |
| 控制循环状态 | `/Library/MacMiniFanControl/fanctl.runtime.json` |
| helper 日志 | `/Library/Logs/MacMiniFanControl/plugin.log` |
| 安装备份 | `/Library/Application Support/MiniArchipel/FanControl/backups/` |

## 验证

`test.sh` 的 C 测试不链接真实 AppleSMC；Python 测试替换硬件、使用真实文件和子进程。Agent HTTP 测试通过本地测试 socket 验证认证、控制开关和独立监测。浏览器测试覆盖草稿、确认、取消、刷新、虚拟机、中英文、两种主题、无横向溢出和无障碍检查。

实机只执行有界的低负载控制与恢复验证；全核负载校准需要在工作台明确发起，不在部署或 CI 中自动运行。
