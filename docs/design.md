# mini-fleet 设计记录

日期：2026-10-16~17。状态：M1–M3 已交付，四机部署（含 VM），runner 可控。

## 已定决策

| 项         | 决定                | 备注                                                               |
| ---------- | ------------------- | ------------------------------------------------------------------ |
| Agent 语言 | Rust                | sysinfo（进程/内存/卷）+ macmon 子进程（频率/功耗）+ axum          |
| Console 栈 | TypeScript          | Fastify + node:sqlite + React 手写卡片                             |
| 拓扑       | Console 常驻 mini-1 | 拉模型；VM 通过 MacBook SSH 隧道中继                               |
| 存储       | SQLite 三表         | samples_raw(1s,24h) / samples_mid(10s,30d) / samples_coarse(1m,1y) |
| 磁盘扫描   | du via SSH 回环     | launchd 下 du 被 IO 节流；6h 周期 + 手动触发 + CPU 峰值延后        |
| 安全       | Bearer token        | agent 数据面 + console UI + runner 控制哨兵                        |
| 插件       | namespace 信封      | 新采集面零迁移                                                     |

## 分类体系（2026-10-17 定稿）

| 类别        | 颜色 | 定义          | 例子                                             |
| ----------- | ---- | ------------- | ------------------------------------------------ |
| system      | 深灰 | OS 组成       | System, usr, private, bin, sbin, .resolve, .vol… |
| apps        | 绿   | 应用          | Applications（展开一级）                         |
| user        | 蓝   | 用户主动创建  | github-runners, .ssh, .config, .docker, Desktop… |
| agentic     | 橙   | AI 助手数据   | .codex, .zcode                                   |
| toolchain   | 橙   | 开发工具      | .rustup, .cargo, .local                          |
| reclaimable | 金   | 可安全清除    | opt, .cache, node_modules, target, .venv…        |
| library     | 紫   | 系统/用户混合 | Library                                          |

## 实现要点（踩坑记录）

- macmon 0.10 CLI 为 `pipe -i <ms>`；usage 字段是 `[freq_mhz, ratio]` 元组
- GitHub `.runner` 文件带 UTF-8 BOM；`workFolder` 为相对路径
- esbuild 打 server 需 `format: cjs`（fastify 顶层 await 与 CJS 互操作）
- macOS 本地网络隐私策略拦未签名 node 的 LAN 访问 → console 轮询走 curl 子进程
- du 在 launchd agent 下被 IO 节流 → 磁盘扫描走 SSH 回环
- APFS firmlink `/System/Volumes/Data` 被 BSD du -x 双重计数 → agent 自动扣减
- macOS 27 du 有时输出带引号路径 → 解析时 trim
- VM（Tart）NAT 是单向的：VM 能出、外部不能直接进 → MacBook SSH 隧道中继
- VM agent 不装 macmon/fanctl（虚拟机无此硬件），对应采集段自动跳过
- 存储/进程/磁盘表格需排序功能 → 待实现（手写排序，零依赖）
