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
扫描请求立即返回，不等待目录遍历；相同目标的重复请求返回同一活动任务。只有全部配置根目录完成且缓存保存成功，
才发布新结果；扫描失败、取消和重启均保留旧结果。取消会终止并回收当前 `du` 子进程。

Agent `POST /rescan-disk` 返回任务，`POST /cancel-disk-scan` 接收 `{ "id": 任务ID }`；
Console 对应 `/api/disk/rescan` 接收 `{ "host": "节点ID", "path": "可选的绝对目录路径" }`，`/api/disk/cancel` 接收 host 和 id。
`snapshot.disk_scan` 持续返回权威状态，刷新浏览器或暂停资源读数不会遗失操作状态。

目录规则集中在 `agent/disk-rules.toml`，内置 macOS 路径、预取层数和用途分类。节点在 `agent.toml` 的 `collectors.disk.rules` 中按完整路径覆盖；启用的插件继续贡献自己的路径，节点覆盖优先。`~` 始终指 Agent 所属用户。未配置的字段继承默认值，`depth = 0` 关闭预取，仍可手动下钻；`use_defaults = false` 可关闭整套默认规则。

```toml
[collectors.disk]
use_defaults = true

[[collectors.disk.rules]]
path = "~/workspaces"
depth = 2
class = "user"

[[collectors.disk.rules]]
path = "~/Library/Caches"
depth = 0
```

`depth` 支持 0–4 层；分类可独立覆盖，可选 system、apps、user、reclaimable、toolchain、agentic、library、appdata。分类按最长路径前缀匹配，边界是目录组件：`/opt` 是安装的软件，`/opt/homebrew` 是工具链，其 var 为应用数据；`.local`、`.cargo` 不再整体视为工具链，share/state 与 Application Support/Containers/Group Containers 属于应用数据，只有明确缓存路径归入可重建缓存。用途分类不授予清理权限。

保留此前的 18 处展开规则，同时明确声明 `/Applications`、`~/Applications`，增加用户 Containers、Group Containers，以及用户与系统 Library 下的 Developer、Logs。应用包、框架、图库及虚拟机包默认视为整体；任意名字为 Applications 的目录不再触发全局特判。不存在的默认目录自然忽略。

使用原生 `du -k -P -x -d N`。每个配置根目录的一次完整遍历按规则决定输出层数（最多 8 层）；`-d` 仅限制输出，统计总量仍遍历完整子树。用户展开未扫描目录时，提交 `{ "path": "绝对路径" }` 启动一次 `-d 1` 的独立后台子目录任务，无需全盘重扫。任务完成且缓存落盘后只替换对应子树，同时更新已存在的重叠根目录视图；未扫描分支保留历史下钻结果与各条目时间戳，完整重扫也不会遗失已缓存的深层结果。不同目标的并发请求返回 409，相同目标返回同一任务。后台子目录任务不推迟周期完整扫描。

路径必须属于配置根目录且已在缓存中可见，拒绝相对路径、越级路径、符号链接、包内部目录及其他挂载点；macOS Data 卷的正常 firmlink 视图保留，`/System/Volumes` 重复视图排除。解析在阻塞工作线程运行，主监测继续采集。错误定位至对应目录和上级；真实空目录保留 0 B，不可读目录显示“不可读取”和缺失大小，不伪装为空。子目录状态区分 unscanned、complete、partial、unreadable、excluded。

界面展开入口自动发起首次扫描，缓存结果直接展开；任务状态和取消入口来自节点，展开路径保存在 URL，刷新后恢复。已展开目录可单独重扫，失败或取消始终保留旧结果，权限恢复后可重试。中英文、浅深主题与移动端使用同一流程。

没有增加扫描依赖。此前卡顿的原因是同步等待外部进程和缺少任务状态，
并非已证实需要更换统计引擎。另一个可行选项是 Foundation 的
[目录枚举](<https://developer.apple.com/documentation/foundation/filemanager/enumerator(at:includingpropertiesforkeys:options:errorhandler:)>)
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

## 前一轮验收（2026-10-18）

Console 0.8.1 的 60 个部署文件通过哈希核对；四节点使用 Agent 0.6.3，签名要求保持不变，SHA-256 为 `68a876bd507600a7f3bdac108ecf1d84a026ea699cc533d36fdf9a0bd3b3e5b8`。

| 节点          | 本轮扫描耗时 | 已验证可展开路径 |
| ------------- | -----------: | ---------------: |
| yd-mini       |      96.7 秒 |               18 |
| yd-mini-2     |      90.9 秒 |               18 |
| yd-mbp-tart   |      38.7 秒 |               18 |
| yd-mbp-tart-2 |      49.7 秒 |               18 |

每台均核对了扫描期间旧结果保留、完成后缓存原子替换且权限为 600、主监测时间持续更新、Runners 四仓库展开和原进程 ID 保留。控制台配置和 SQLite 完整性通过核对，16 个 Runner 远端在线，两台实体机的传感器保持齐全。

本地 `npm run check` 通过（88 个单元测试）；`npm run check:agent` 通过（13 个 Rust 测试、4 个真实 HTTP 集成测试）。浏览器覆盖 Chromium、WebKit 和移动端的页面、主题、语言及无障碍，最终对目录展开、0 B 条目、保护档和概览布局的针对性复测为 24/24。

## 目录规则与按需扫描验收（2026-10-18）

四节点使用 Agent 0.7.0，最终签名 SHA-256 为 `053130a0d3638945493cd812d884b8eb02cb909c0c970ae30989b97e959d09c9`，保持同一 designated requirement。Console 0.9.0 的 60 个部署文件通过哈希核对，界面、接口及启动信息版本一致。节点配置和 CI 钩子保持原样，16 个 Runner 的进程 ID 与远端在线状态通过核对；实体机的 48 项传感器与 SQLite 完整性通过检查。

| 节点          | 完整扫描耗时 | 已核对的规则路径 | 观测快照请求最大耗时 |
| ------------- | -----------: | ---------------: | -------------------: |
| yd-mini       |      97.2 秒 |               23 |           130.1 毫秒 |
| yd-mini-2     |      91.8 秒 |               23 |            85.2 毫秒 |
| yd-mbp-tart   |     204.7 秒 |               23 |           209.2 毫秒 |
| yd-mbp-tart-2 |     207.6 秒 |               23 |           147.4 毫秒 |

四台均验证了真实运行中取消、旧结果保留、完整扫描缓存原子替换、分类修正、两层子目录定向替换、无关分支保持不变以及重启后恢复。控制台实机逐台扫描 `~/runners/mini-archipel/externals`，刷新后保留展开路径与结果；已核对中英文和浅深主题截图，无浏览器 JavaScript 错误。系统保护目录如实保持不可读取/部分不可读取，未伪装成空目录。

本地 `npm run check` 通过：88 个单元测试，语句覆盖率 88.81%、分支覆盖率 83.53%。Agent 格式、Clippy、8 个 Rust 测试、发布构建和 5 个真实 HTTP 集成测试通过，覆盖规则覆盖、深路径祖先、分类与深度独立、越界/符号链接/包路径拒绝、权限失败、取消及恢复。

浏览器先做全量 120 个场景覆盖，随后修正验收环境在运行期间重建资源造成的模块 404、WebKit 多页无障碍检查的时间预算，以及动画取样断言。最终针对存储、按需扫描、暂停恢复和深色无障碍复测，Chromium、WebKit、移动端共 27/27 通过。
