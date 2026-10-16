# mini-fleet

Mac mini 集群管理控制台：一到四台 Apple Silicon 机器（物理机 + 虚拟机）的实时指标、活跃进程、历史曲线、存储容量明细，以及插件化的扩展面板（GitHub Runner 监视与控制）。

| 组件           | 语言                                        | 位置                                         |
| -------------- | ------------------------------------------- | -------------------------------------------- |
| **agent**      | Rust（sysinfo + macmon + axum）             | 每台 mini / VM，用户 LaunchAgent，~19MB 内存 |
| **console**    | TypeScript（Fastify + node:sqlite + React） | mini-1 常驻，浏览器访问                      |
| **vm-tunnels** | SSH 隧道守护                                | MacBook（VM 的 NAT 网络需要中继）            |

姊妹仓库：[mac-mini-provisioning](https://github.com/yaindrop/mac-mini-provisioning)（怎么装机）、
[mac-mini-fan-control](https://github.com/yaindrop/mac-mini-fan-control)（agent 采集其风扇状态）。

## 架构

```
浏览器 ── WS/HTTP ── console（mini-1:9100）
                        │ SQLite（1s 原始 24h / 10s 30d / 1m 1 年）
                        │ curl 轮询（Bearer token，每机每秒 1 个 /snapshot）
                  ┌─────┼─────────────────┐
                  │     │                 │
              agent(mini-1) agent(mini-2)  SSH隧道(MacBook)
              127.0.0.1:9101  192.168.9.237:9101  :9102/:9103
                                              │       │
                                          yd-mbp-tart  yd-mbp-tart-2
                                          (VM agent)   (VM agent)
```

Agent 采集：CPU 占用（每核）、E/P 核群频率、GPU、内存三口径、swap、卷可用空间、
Top 15 活跃进程、热状态、风扇（mac-mini-fan-control 接口）、磁盘分类树、
GitHub Runner 状态。macmon / fanctl 缺席时对应段自动省略。

## 功能

### 实时仪表盘

- 四机卡片：CPU（含 12 核 mini 柱状图）/ 内存 / 存储容量（40G 水位线）/ GPU / 功耗 / 风扇+热状态
- 活跃进程表（完整展示，不截断）
- WebSocket 秒级推送 + 断线重连 + 页面隐藏暂停
- 历史曲线视图（10 分钟/1 小时/24 小时窗口）

### 存储容量明细

- `/` 和 `~` 两棵树，各看所有一级；`/Applications` 和 `~/Applications` 展开一级
- 七色分类：system / apps / user / reclaimable / toolchain / agentic / library
- 手动「立即扫描」按钮（6 小时自动周期，CPU >50% 时自动延后半小时）
- du 走 SSH 回环绕开 launchd IO 节流

### GitHub Runner 插件

- runner 发现（注册信息 / Listener/Worker 进程 / _work 与 _diag 占用 / 最新日志名）
- 启用/停用按钮（launchctl enable/disable + bootout/bootstrap）
- 作业运行中自动禁用按钮（防止中断 CI）
- GitHub 侧富化（online/busy）——console.json 配 `githubToken` + `githubRepo` 即启用
- agent 侧控制开关哨兵（`MINIFLEET_ALLOW_RUNNER_CONTROL=1`）

### 虚拟机接入

- Tart VM 通过 MacBook SSH 隧道中继（`local.minifleet.vm-tunnels` LaunchAgent）
- 自动重连（每 15 秒检查），VM 随时停机/上线不影响系统
- VM agent 自动跳过风扇/macmon（虚拟机无此硬件）

## 部署

Agent（每台 mini，先装好 macmon：`brew install macmon`）：

```sh
./agent/build.sh && ./agent/install.sh   # 生成 token 并打印
```

Console（mini-1；需要 node ≥ 24 与已构建的 dist）：

```sh
cd console && npm install && npm run build && ./install.sh
# 编辑 ~/.config/mini-fleet/console.json 填入各 agent token 后重启服务
```

VM 隧道（MacBook，需要能 SSH 到各 VM）：

```sh
# ~/.local/libexec/ 下放隧道守护脚本，或直接用内嵌循环版 LaunchAgent
# 详见 ~/Library/LaunchAgents/local.minifleet.vm-tunnels.plist
```

访问：`http://<mini-1>.local:9100/?token=<uiToken>`。

## 配置

`~/.config/mini-fleet/agent.toml`（600）：

```toml
bind = "0.0.0.0:9101"
token = "<hex>"
[collectors]
proc_interval_ms = 2000       # 活跃进程
thermal_interval_ms = 5000    # 热状态
fan_interval_ms = 2000        # 风扇
disk_interval_ms = 21600000   # 磁盘树（6 小时）
runner_interval_ms = 5000     # runner 探测
macmon = "/opt/homebrew/bin/macmon"
fanctl = "/Library/MacMiniFanControl/fanctl"
disk_roots = ["~"]
```

`~/.config/mini-fleet/console.json`（600）：

```json
{
  "bind": "0.0.0.0:9100",
  "uiToken": "<hex>",
  "dbPath": "~/.local/share/mini-fleet/console.db",
  "githubToken": "<optional PAT>",
  "githubRepo": "yaindrop/flow-bit",
  "hosts": [
    { "name": "mini-1", "url": "http://127.0.0.1:9101", "token": "..." },
    { "name": "mini-2", "url": "http://192.168.9.237:9101", "token": "..." },
    { "name": "yd-mbp-tart", "url": "http://<macbook>:9102", "token": "..." },
    { "name": "yd-mbp-tart-2", "url": "http://<macbook>:9103", "token": "..." }
  ]
}
```

## 安全模型

- Agent 数据面：Bearer token，仅监听局域网
- Console UI/API/WS：Bearer token
- Runner 控制：agent 侧需环境变量 `MINIFLEET_ALLOW_RUNNER_CONTROL=1` 显式开启
- GitHub 凭据：仅 console 主机的 gh 登录态，agent 不持有
- VM 隧道：SSH key 认证，MacBook 本地转发

## 运维备忘

- macOS 本地网络隐私策略拦未签名二进制的局域网访问：agent 首次部署后需
  `sudo socketfilterfw --add <binary>`；console 轮询走 `/usr/bin/curl` 规避
- `.local` mDNS 会广播无路由的 IPv6 地址，跨机通信需钉 IPv4 或直接用 IP
- du 在 launchd agent 下被 IO 节流：磁盘扫描走 SSH 回环（`~/.ssh/id_mini_fleet`）
- APFS firmlink `/System/Volumes/Data` 会被 du 双重计数：agent 自动扣减
- macOS 27 BSD du 有时输出带引号的路径（含空格），agent 解析时 trim

## 采集频率与开销

| 指标              | 频率      | 开销                      |
| ----------------- | --------- | ------------------------- |
| CPU/内存/卷       | 1s        | 极轻                      |
| 活跃进程          | 2s        | 轻                        |
| E/P/GPU 频率+功耗 | 1s 流     | 0.9% CPU（macmon 子进程） |
| 风扇              | 2s        | 极轻                      |
| 热状态            | 5s        | 极轻                      |
| runner            | 5s        | 轻                        |
| 磁盘树            | 6h 或手动 | 重（30s），后台错峰       |
| 主机信息          | 60s       | 极轻                      |

全套监控稳态：每台 ~1–2% 单核 + 19MB 内存。SQLite 稳态 <2 GB/年。
