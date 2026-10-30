# 桌面自动化插件验收记录

日期：2026-10-30。先在 `yd-mini-2` 使用独立 Agent、Console 验证，再按用户要求正式部署到
`yd-mini`、`yd-mini-2`。测试聊天只要求回复固定标记，不调用工具或修改文件。

## 正式部署

- 正式入口：<https://yd-mini.local:9100/desktop-automation>。
- `yd-mini`：升级 Console、Agent，首次安装桌面工具包和 Runner App；用户完成首次系统授权。
- `yd-mini-2`：升级 Agent、桌面工具包，保留原 Runner App。两台均启用插件、桌面控制及脚本执行。
- 节点稳定键保持 `mini-1`、`mini-2`；原有配置内容、令牌、HTTPS 与历史数据库均保留。
- 两台分别沿用原 Agent 签名证书，安装文件与对应已验证发布文件的 SHA-256 一致。
- 程序上一版由现有安装器保存；两台配置备份位于各自
  `~/.local/share/mini-archipel/backups/desktop-deploy-20261030/`。
  yd-mini 的 SQLite 在线备份通过完整性检查。
- 正式 API 验证两台权限、字面参数脚本、重复请求返回原结果和脱敏诊断；yd-mini-2 的
  Codex/ZCode 历史回复读取通过。集群四个节点在线，24 小时历史查询返回 1181 个点。
- 正式 HTTPS 的 CA/主机名校验、未登录 401、跨站写入 403 均通过；页面实时连接及布局正常。
  自动化浏览器临时上下文忽略私有 CA 错误，TLS 独立校验使用配置中的真实证书链，未改系统信任设置。

首次安装暴露了版本查询属于免授权事件的问题。现已通过受权限保护的 System Events
进程枚举发起请求，再独立复验能力；用户确认时发生的 AppleEvent `-609` 连接失效也先复验，
不直接误报授权失败。已有 App 无需重签。

## Tart 节点启用

同日按用户要求，将同一已验证发布的 Agent 与桌面工具包部署到 `yd-mbp-tart`、
`yd-mbp-tart-2`，通过正式 Console API 启用两台的 `desktop-automation` 和 `mini-proxy`。
两台均保留原 Agent 签名身份，旧配置除新增插件项外保持一致；配置备份位于各自
`~/.local/share/mini-archipel/backups/tart-plugins-20261030/`。

用户完成两台首次系统授权，辅助功能及 System Events 自动化均复验为 true。
正式入口的脚本执行、重复请求去重及工作台结果展示通过。两台未安装 Codex/ZCode，
因此聊天适配器尚无目标应用，通用脚本入口可用。

代理插件的开关为 enabled，但后端可用性为 `not_installed`：两台未安装独立 mini-proxy，
现有 `com.flowbit.ci-proxy` 仍使用 v2rayN 目录中的 Xray。按用户禁止操作 v2ray/v2rayN 的规则，
此次没有迁移、重启或修改该代理；监听进程 PID 455 / 439 保持不变。
插件开关启用不代表出口管理已可用。两台原代理配置、系统代理与用户登录设置均未改动。

验收记录为本机 `console/.preview/desktop-automation/tart-*.json`（不含令牌）。

## 完成范围

| 优先级 | 交付 | 实际验证 |
| --- | --- | --- |
| P0 | 安装、升级、回滚 | 节点上回滚后再升级成功；既有 App 全文件摘要不变，授权继续有效；编译失败保留旧版有单测 |
| P0 | 环境自检与授权引导 | AX、System Events、登录会话、锁屏和应用检测通过；打开系统设置、请求权限后重新检查真实子进程能力 |
| P0 | 插件 API 与 CLI | Console 与 Agent 两端校验开关；原有鉴权；CLI 的 capabilities、submit、wait、get、diagnostics 实机通过 |
| P1 | 后台任务与恢复 | 先落盘再执行；重复 ID 返回原结果；内容冲突、worker 消失、超时、取消和权限复检失败覆盖单测 |
| P1 | 桌面协调 | 实机暂停拒绝新任务、允许查询原结果，恢复后可执行；暂停后未派发任务不会操作桌面 |
| P1 | 工作台与诊断 | 节点入口、独立页面、任务耗时/结果；中文/英文、浅色/深色、手机页面；诊断脱敏实测 |

## 实机性能与消息核对

这是单次验收记录，不是统计分位数。耗时包含本地 Console → SSH 隧道 → 节点 Agent →
Runner → App；“回复完成”还包含模型生成与结果轮询。

| 操作 | API 受理 | 回复完成 | App 界面操作 |
| --- | ---: | ---: | ---: |
| Codex 继续历史对话 | 79 ms | 5845 ms | 164 ms |
| ZCode 新建对话 | 75 ms | 4325 ms | 210 ms |
| ZCode 继续该对话 | 75 ms | 3844 ms | 268 ms |

上表是独立预览链路；正式 Console 上的验收样本受理耗时为 2.9–3.8 秒，
包含正式节点状态刷新与传输，不能把预览数据作为生产端到端延迟承诺。

验收请求前缀为 `plugin-a4853faf-`。Codex 与 ZCode 新建请求再次提交相同内容和 ID，
返回已有结果。随后直接只读核对 Codex rollout 和 ZCode `turn_usage` 所对应的用户消息：
三个成功请求各 **1 条**，没有重复发送。一个旧 ZCode 目标不在已加载侧栏，明确报告
`sent=false`，该目标中对应消息 **0 条**。

通用程序执行验证了中文、引号、美元符、反引号及换行按字面传递；没有作为 shell 展开。
取消验证使用 `sleep 30`，任务进入 cancelled；诊断中没有测试消息、脚本参数和令牌。
升级后的授权引导再次通过，返回辅助功能与自动化均 true、当前用户已登录且未锁屏。

升级和回滚前后 Runner App 的全部文件内容摘要一致：
`9b3033deae58607e19aa7d113011e918ca27ee893ae7f835fc344b3b9f67ff36`。
安装器替换辅助程序，不替换已授权 App。

## 自动检查

- Python：31 个测试通过，包括既有 Codex/ZCode 适配器和回执测试、任务、安装与首次授权回归测试。
- Agent：25 个测试通过，release 构建、格式检查、生产二进制 Clippy 通过。
- Console：`pnpm check` 通过，包含翻译、类型、ESLint、Biome、格式、Knip、121 个测试、覆盖率和生产构建。
- 浏览器：桌面 Chrome、Safari、手机共 9 个用例通过，覆盖提交/重试/刷新、暂停/恢复、诊断下载、可访问性与横向溢出。
- 实际节点界面另截图核对中文桌面、中文手机、英文深色三种布局。

正式发布冻结源码后，全目标 Agent Clippy、25 个 Rust 测试及 release 构建通过。
Agent 保留原生产 Mini Proxy 实现；Console 保留与已部署 sourcemap 一致的 Mini Proxy 界面。
工作区另有未部署的 Agent Mini Proxy 变化，其测试 dead_code 告警未纳入此次发布。

## 边界

- yd-mini 首次授权由用户完成；没有撤销 yd-mini-2 现有授权，不能宣称绕过系统确认。
- 本次实机是已登录、未锁屏的会话；锁屏信息可检测，未进行强制锁屏或退出登录测试。
- ZCode 目标须在已加载侧栏可定位；Codex 同名标题拒绝发送；此版本 Codex 适配器不提供新建对话。
- 取消聊天只停止本地等待，不能撤销消息或保证 App 内模型停止；中断后用原请求核实，不能自动换 ID 重发。
- 安装、权限缓存、回执和任务 worker 位于节点；正式 Console 在 yd-mini 展示与路由。
  上线验证后已停止本机预览 Console、SSH 预览隧道及节点预览 Agent。

本机验收原始记录（含真实测试结果，不含访问令牌）位于
`console/.preview/desktop-automation/` 的 `live-initial.json`、`live.json`、
`history-counts.json`、`install-verification.json`、`cli-verification.json`、`production-acceptance.json`、
`production-install-verification.json`、`production-service-verification.json`、`production-browser.json` 与检查日志。
该目录不纳入 Git；`credentials.json` 和 `production-credentials.json` 是本机私有配置，不能作为诊断包分享。
