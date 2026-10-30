# 桌面自动化插件

Mini Archipel 内置可选插件 `desktop-automation`。控制台沿用现有节点认证与插件开关；
节点 Agent 调用本机工具包，由固定 `Agent Script Runner.app` 执行桌面操作。
用户电脑不参与节点执行，浏览器关闭或 HTTP 断开不会自动重发已接收的任务。

需求和验收边界见 [REQUIREMENTS.md](REQUIREMENTS.md)，实测结果见 [VALIDATION.md](VALIDATION.md)。

## 安装与升级

在目标 Mac 的仓库中运行：

```sh
python3 desktop-automation/install.py
```

需要 Python 3、Xcode Command Line Tools（`xcrun swiftc`）和已登录的桌面用户。
首次安装创建 `~/Agent Script Runner.app` 及 `~/agent-script-runner`；已有的同身份 App 保持原样，
不会重新签名。辅助程序安装在 `~/.local/libexec/mini-archipel-desktop/`。
先编译再替换，保留 `.previous`；编译或健康检查失败时保留/恢复旧版本。
安装锁与任务锁阻止并发升级；活动任务存在时拒绝升级。手工回滚：

```sh
python3 desktop-automation/install.py --rollback
```

插件随 Agent、Console 编译注册。先构建并通过项目安装器升级这两个组件，再在插件管理页启用。
首次节点配置可使用项目现有离线配置命令（运行中改动需要按项目流程重启 Agent）：

```sh
printf '%s\n' '{"allow_control":true,"allow_scripts":false}' |
  ~/.local/libexec/mini-archipel-agent configure-plugin \
  ~/.config/mini-archipel/agent.toml desktop-automation true
```

`allow_control` 允许聊天、授权引导、取消和桌面协调；`allow_scripts` 还必须显式开启才允许任意
AppleScript/程序执行。两项默认 false。只读状态、诊断、自检与任务结果不要求控制开关。
Console 插件 `options` 为 `{}`。节点可配置 `interval_ms`（1000–60000，默认 2000）和绝对 `toolkit` 路径。

## 控制台

打开 `/desktop-automation`，选择执行节点。节点详情也有插件入口。

- **检查环境与权限**：读取安装状态、辅助功能、System Events 自动化、桌面会话和锁屏情况。
  普通状态轮询不弹权限窗口；检查时间明确显示，不把旧结果冒充实时授权。
- **授权引导**：在节点打开对应设置页并发起请求，后台等待并复验。密码、Touch ID 和“允许”由
  用户在节点屏幕或屏幕共享中完成。首次辅助功能权限可能仍需用户手动打开开关。
- **任务**：操作 Codex/ZCode 或运行节点上的脚本。填写绝对路径，参数是 JSON 字符串数组，
  按字面传递；需要 shell 语义时由调用方明确选择 shell 程序及参数。
- **人工接管**：先暂停接单；等当前任务结束或取消后，确认桌面不再被占用，再人工操作。恢复后可提交新任务。
- **诊断包**：下载系统、应用、工具包版本与文件校验和、权限和任务元数据；不包含消息正文、
  脚本参数、执行输出、自由文本错误、访问令牌或密码。

窗口位置和控件依赖 App 版本。ZCode 目标须能在当前已加载侧栏中找到；Codex 同名标题拒绝操作。
Codex 新建对话尚未封装为此适配器操作；可继续历史对话。ZCode 支持新建。

## 其他 Agent 调用

提供 `desktopctl.py`，只使用标准库。令牌取自环境变量 `ARCHIPEL_TOKEN`，不接受 URL 内凭据。
令牌是 **Console** 的 API 令牌，调用者不需要掌握各节点 Agent token，也不需要节点 SSH 密钥。

```sh
python3 desktop-automation/desktopctl.py --url https://yd-mini.local:9100 \
  --host mini-2 capabilities
python3 desktop-automation/desktopctl.py --url https://yd-mini.local:9100 \
  --host mini-2 submit <<'JSON'
{"request_id":"job-001","operation":"chat","app":"codex","mode":"send","target":"THREAD_UUID","message":"你的任务","timeout":120}
JSON
python3 desktop-automation/desktopctl.py --url https://yd-mini.local:9100 \
  --host mini-2 wait job-001 --timeout 180
```

其他命令：`status`、`get ID`、`cancel ID`、`pause`、`resume`、`diagnostics`。
`--host` 使用控制台配置的稳定节点键；当前正式部署的 yd-mini、yd-mini-2 分别是 `mini-1`、`mini-2`。
同一逻辑请求必须复用相同 `request_id` 和完整内容。ID 为 1–100 个字母、数字、下划线或短横线，
首字符必须为字母或数字。`wait` 超时只结束等待，`get` 可以继续查；网络错误也不自动换 ID 重发。

Console API：`POST /api/plugins/desktop-automation/actions/:action`，沿用 Bearer/会话鉴权与跨站写入保护。

| action | 请求体 |
| --- | --- |
| `status` / `diagnostics` | `{ "host": "节点ID" }` |
| `submit` | `{ "host": "节点ID", "request": { ...下表... } }` |
| `get` / `cancel` | `{ "host": "节点ID", "request_id": "job-001" }` |
| `coordinate` | `{ "host": "节点ID", "paused": true }` |

提交请求都包含 `request_id`、`operation`，可选整数 `timeout` 为 1–900 秒（默认 120）：

| operation | 其他字段 |
| --- | --- |
| `doctor` | 无 |
| `permissions` | `permission`: `accessibility` 或 `automation`；当前引导壳自身所需的这两项权限 |
| `chat` | `app`: `codex` / `zcode`；`mode`: `send` / `new` / `read` / `probe` / `recover` |
| `script` | `mode`: `run` / `exec`；`path`: 节点绝对路径；`arguments`: 字符串数组 |

聊天 `send` 需要 `target` 和 `message`；`new` 仅 ZCode，需 `message`；`read` / `probe` 需要 `target`。
`recover` 使用 `original_request_id`，它是原聊天发送请求的 ID；本次恢复任务另用一个新的 `request_id`。
发送完成条件是任务已完成且 `job.result.status` 为 `completed`。脚本的最终结果包含壳的退出码和 stdout/stderr。

节点上的独立入口也可使用，接收节点本地请求（无 `host` 包装）：

```sh
~/.local/libexec/mini-archipel-desktop/desktop-automation status
~/.local/libexec/mini-archipel-desktop/desktop-automation submit < request.json
~/.local/libexec/mini-archipel-desktop/desktop-automation wait job-001
```

## 回执、生命周期与取消

任务在 `~/.local/share/mini-archipel/desktop-automation/` 以 0700 目录、0600 文件保存。
发送前写入原子回执并 fsync；输入内容与相同 ID 冲突时拒绝。
节点后台进程独立于 HTTP/SSH，会话结果通过 `get` 返回；快照只包含任务元数据。
节点/worker 意外退出后，旧任务标为 `interrupted`，不会自动重新执行脚本。
聊天适配器另有 `~/.agent-chat-requests/` 回执，`recover` 只核实原发送，不再次按发送按钮。

任务状态：`queued`、`running`、`waiting_user`、`completed`、`failed`、`cancelled`、`interrupted`、`needs_user`。
权限等待超时为 `needs_user`，不是已授权。未知的权限查询结果显示尚未检查，不按拒绝处理。
插件关闭停止采集并拒绝新 API 操作，已接收的节点任务继续；重新启用后可查询。

取消使用工作进程轮询的标记文件，不向持久化 PID 直接发信号。运行中的子进程先请求中断，
必要时终止本次子进程组；不退出 Codex/ZCode App。
**取消聊天等待不能撤回已发送的消息，也不能保证停止 App 内部模型。** 任意脚本自行创建的
脱离进程组后台后代不保证被清理。单次结果限制为 1 MiB，超限停止本次等待并报告。
不同请求 ID 不会去重；本机回执不是服务端跨设备恰好一次协议。不要删除回执后用相同 ID 重发。

## 验证

```sh
python3 -m unittest discover -s desktop-automation/runtime -p 'test_*.py'
cd agent && cargo fmt --check && cargo test --locked
cd ../console && pnpm check
pnpm exec playwright test tests/browser/desktop-automation.spec.ts
```

单元测试和浏览器 fixture 不操作真实 App。实机验证使用专用测试对话，单独记录实际发送次数，
不把 fixture 成功或队列已接收当成真实完成。
