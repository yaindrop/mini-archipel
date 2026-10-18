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

使用 macOS 原生 `du -k -x -d 3`，每个扫描根目录只运行一次，保留同一轮遍历中的三层统计，避免为每个可展开目录重复扫描。内置为 `~/.local`、`~/Library`、`~/.cache`、`/Users`、`/System`、`/private`、`/Library`、`/usr`、`/opt` 和 Applications 保留一层子目录。

`~/Library/Caches`、`~/Library/Application Support`、`~/.local/state`、`~/.local/share`、`/System/Library`、`/Library/Caches`、`/Library/Application Support`、`/private/var`、`/opt/homebrew` 继续提供下一层。其他扩展路径仍由插件声明（例如 Runners 的安装目录）；未声明目录不展开，第三层的节点不再保留子目录。真实的 0 B 目录同样保留，避免空目录及其展开入口消失；系统拒绝读取的部分继续保留部分不可读状态。系统、工具链和缓存的后代继承相应用途，避免把展开内容误计为用户数据。`/System/Volumes` 的重复卷统计同时从 System 总量和子目录列表中移除。

没有增加扫描依赖。此前卡顿的原因是同步等待外部进程和缺少任务状态，
并非已证实需要更换统计引擎。另一个可行选项是 Foundation 的
[目录枚举](https://developer.apple.com/documentation/foundation/filemanager/enumerator(at:includingpropertiesforkeys:options:errorhandler:))
配合 [totalFileAllocatedSizeKey](https://developer.apple.com/documentation/foundation/urlresourcekey/totalfileallocatedsizekey)，
但它需要自行维护硬链接去重、挂载边界、错误汇总和 APFS 统计语义。当前先让原生工具承担遍历，
Agent 只负责生命周期、状态和发布；之后以节点实测耗时决定是否替换。

实机排查还确认了独立的权限问题：扫描进程在 `open` 等待时，`tccd` 日志出现 Photos
授权提示，以及虚拟机旧 Full Disk Access 记录的代码签名要求失配。对照测试默认 I/O
策略和 Interactive 进程类型没有解除该等待，实验设置已恢复。不能把该问题归因于
`du` 遍历算法，也不能通过换枚举 API 修复旧授权。
四节点现已迁移到[固定的本地签名身份](../agent/SIGNING.md)，后续构建保持相同证书和标识，并在分发前核对 designated requirement；同一身份升级不再使用绑定单一版本的临时签名。Apple 对跨版本身份的解释见
[TN3127](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)。
公开分发应使用 Apple Developer ID 与适用的分发流程。

## 资源走势与风扇编辑器（2026-10-18）

集群概览和节点详情同时展示 CPU、内存图表。宽屏三栏比例为 2:2:1，第三栏分别为需要关注、传感器；窄屏先让第三栏独占一行，移动端纵向排列。

风扇曲线横轴固定为 20–100°C。系统接管段在零线用波浪表示，右侧显示“系统默认”，零线不表示实际风扇停转，实际转速仍由硬件读数给出。策略配置中的基础档仍按控制端约定保留 `0:min_rpm`。

最后一档为保护档，温度输入和图上拖动会同时调整该点与 `critical_temp`，转速锁定 `max_rpm`（100%）。达到保护温度后，控制循环依据未经平滑的传感器峰值直接使用最高转速；普通档位继续使用阶梯、平滑、降档滞回与等待时间。保护温度集中在最后一档编辑，不再在下方重复提供入口。界面中英文含义一致，编辑只保存草稿，仍须确认应用到节点。

## 本轮验收（2026-10-18）

Console 0.8.1 的 60 个部署文件通过哈希核对；四节点使用 Agent 0.6.3，签名要求保持不变，SHA-256 为 `68a876bd507600a7f3bdac108ecf1d84a026ea699cc533d36fdf9a0bd3b3e5b8`。

| 节点 | 本轮扫描耗时 | 已验证可展开路径 |
| --- | ---: | ---: |
| yd-mini | 96.7 秒 | 18 |
| yd-mini-2 | 90.9 秒 | 18 |
| yd-mbp-tart | 38.7 秒 | 18 |
| yd-mbp-tart-2 | 49.7 秒 | 18 |

每台均核对了扫描期间旧结果保留、完成后缓存原子替换且权限为 600、主监测时间持续更新、Runners 四仓库展开和原进程 ID 保留。控制台配置和 SQLite 完整性通过核对，16 个 Runner 远端在线，两台实体机的传感器保持齐全。

本地 `npm run check` 通过（88 个单元测试）；`npm run check:agent` 通过（13 个 Rust 测试、4 个真实 HTTP 集成测试）。浏览器覆盖 Chromium、WebKit 和移动端的页面、主题、语言及无障碍，最终对目录展开、0 B 条目、保护档和概览布局的针对性复测为 24/24。
