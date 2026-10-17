# 群岛 · 节点工作台 设计记录

日期：2026-10-17。当前架构采用基础监控核心与可独立启停的内置运维插件，详见 [插件系统](plugins.md) 和 [架构决策](adr/0001-optional-operation-plugins.md)。

## 已定决策

| 项         | 决定                 | 备注                                                               |
| ---------- | -------------------- | ------------------------------------------------------------------ |
| Agent 语言 | Rust                 | sysinfo（进程/内存/卷）+ macmon 子进程（频率/功耗）+ axum          |
| Console 栈 | TypeScript           | Fastify + node:sqlite + React / Ant Design 6                       |
| 拓扑       | Console 常驻 mini-1  | 拉模型；VM 通过 MacBook SSH 隧道中继                               |
| 存储       | SQLite 三表          | samples_raw(1s,24h) / samples_mid(10s,30d) / samples_coarse(1m,1y) |
| 磁盘扫描   | 本地异步 du 子进程   | 6h 周期 + 手动触发；持久化任务、取消、保留上次完整结果             |
| 安全       | Bearer token         | Agent Bearer；Console HttpOnly 会话 / Bearer；插件独立控制权限     |
| 插件       | 版本化信封与注册接口 | 生命周期、命令、后台集成及 UI 扩展由插件拥有                       |

## 分类体系（2026-10-17 定稿）

| 类别        | 颜色 | 定义          | 例子                                             |
| ----------- | ---- | ------------- | ------------------------------------------------ |
| system      | 深灰 | OS 组成       | System, usr, private, bin, sbin, .resolve, .vol… |
| apps        | 绿   | 应用          | Applications（展开一级）                         |
| user        | 蓝   | 用户主动创建  | runners, .ssh, .config, .docker, Desktop…        |
| agentic     | 橙   | AI 助手数据   | .codex, .zcode                                   |
| toolchain   | 橙   | 开发工具      | .rustup, .cargo, .local                          |
| reclaimable | 金   | 可安全清除    | opt, .cache, node_modules, target, .venv…        |
| library     | 紫   | 系统/用户混合 | Library                                          |

## 实现要点（踩坑记录）

- macmon 0.10 CLI 为 `pipe -i <ms>`；usage 字段是 `[freq_mhz, ratio]` 元组
- GitHub `.runner` 文件带 UTF-8 BOM；`workFolder` 为相对路径
- esbuild 打 server 需 `format: cjs`（fastify 顶层 await 与 CJS 互操作）
- macOS 本地网络隐私策略拦未签名 node 的 LAN 访问 → console 轮询走 curl 子进程
- 扫描子进程异步运行，不占用主监测线程，不通过 SSH 回环执行。
- APFS firmlink `/System/Volumes/Data` 被 BSD du -x 双重计数 → agent 自动扣减
- VM（Tart）NAT 是单向的：VM 能出、外部不能直接进 → MacBook SSH 隧道中继
- VM agent 不装 macmon/fanctl（虚拟机无此硬件），对应采集段自动跳过
- 存储、进程和节点表格使用 Ant Design Table；排序与筛选由各页面维护。

## 后台目录扫描（2026-10-18）

扫描任务按 `queued → running → completed / cancelled / failed` 变化，取消时先进入
`cancelling`；进程重启将未完成任务改为 `interrupted`。任务 ID、状态、当前根目录和最近完整结果
保存在节点 `~/.local/share/mini-archipel/disk-scan.json`，权限 600，通过临时文件原子替换。
扫描请求立即返回，不等待目录遍历；重复请求返回同一活动任务。只有全部配置根目录完成且缓存保存成功，
才发布新结果；扫描失败、取消和重启均保留旧结果。取消会终止并回收当前 `du` 子进程。

Agent `POST /rescan-disk` 返回任务，`POST /cancel-disk-scan` 接收 `{ "id": 任务ID }`；
Console 对应 `/api/disk/rescan` 接收 `{ "host": "节点ID" }`，`/api/disk/cancel` 接收 host 和 id。
`snapshot.disk_scan` 持续返回权威状态，刷新浏览器或暂停资源读数不会遗失操作状态。

保留 macOS 原生 `du -k -x -d 1`，没有增加扫描依赖。此次卡顿的原因是同步等待外部进程和缺少任务状态，
并非已证实需要更换统计引擎。另一个可行选项是 Foundation 的
[目录枚举](https://developer.apple.com/documentation/foundation/filemanager/enumerator(at:includingpropertiesforkeys:options:errorhandler:))
配合 [totalFileAllocatedSizeKey](https://developer.apple.com/documentation/foundation/urlresourcekey/totalfileallocatedsizekey)，
但它需要自行维护硬链接去重、挂载边界、错误汇总和 APFS 统计语义。当前先让原生工具承担遍历，
Agent 只负责生命周期、状态和发布；之后以节点实测耗时决定是否替换。

实机排查还确认了独立的权限问题：扫描进程在 `open` 等待时，`tccd` 日志出现 Photos
授权提示，以及虚拟机旧 Full Disk Access 记录的代码签名要求失配。对照测试默认 I/O
策略和 Interactive 进程类型没有解除该等待，实验设置已恢复。不能把该问题归因于
`du` 遍历算法，也不能通过换枚举 API 修复旧授权。
当前本地构建为 ad hoc 签名，其 designated requirement 绑定具体版本；更新后完整扫描需要
在四节点系统设置中重新添加 Agent 的完全磁盘访问权限。Apple 对跨版本身份的解释见
[TN3127](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)。
持续分发时应使用稳定的正式签名身份；本机构建环境目前没有可用的代码签名证书。
