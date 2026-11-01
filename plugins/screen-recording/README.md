# Mini Archipel Screen Recorder

macOS 15+ 的本地、屏幕专用录制工具。原生 ScreenCaptureKit / SCRecordingOutput 输出 H.264 MP4；不依赖网络、GUI 自动化或任何调用客户端。普通录屏不请求麦克风、系统音频或输入权限。可显式选择独立鼠标事件 sidecar；视频不烘焙光效，也不依赖渲染器。

生产录制与逐步真实PNG核图的REST/回执/下载规则见 [制作接口](PRODUCTION.md)。

## 构建与安装

需要带 macOS 15+ SDK 的 Xcode Command Line Tools。

```sh
scripts/build.sh
scripts/install.sh
export PATH="$HOME/.local/bin:$PATH"
agent-screen-recorder identity
```

App随系统语言显示为英文 `Mini Archipel Plugin: Screen Recorder` / 中文 `群岛插件：屏幕录制`。固定技术身份： `org.agent-screen-recorder.app`，安装到 `~/Applications/Mini Archipel Plugin - Screen Recorder.app`。CLI名称保留兼容：CLI 固定为 `~/.local/bin/agent-screen-recorder`。初次安装拒绝覆盖；正常升级运行 `scripts/install.sh --upgrade`，只在本工具空闲且无待处理请求时退出其helper，完整备份旧App/CLI并将旧 `Agent Screen Recorder.app` 迁到备份。数据目录及Bundle ID沿用旧技术身份，不改TCC。回滚用 `scripts/install.sh --rollback "备份目录"`，同样先检查空闲；安装失败会恢复备份。构建与安装不会启动 App、弹权限或开始采集。可用同一 `ASR_BUILD_DIR=build/revision` 前缀运行两个脚本，在独立目录构建/安装候选并保留旧包。

默认本地 ad-hoc 签名；可用 `SIGN_IDENTITY='既有证书指纹' SIGN_KEYCHAIN='/path/scoped.keychain-db' scripts/build.sh` 使用已有持续签名身份（先按该身份现有流程安全解锁，不在命令行传密码）。本地自签证书可能仅出现在 `security find-identity -p codesigning` 的匹配列表，不在可信有效列表；不要因此每次新建证书。分发前核对签名证书与designated requirement，后续版本须保持同一证书和Bundle ID。无开发者证书时不保证跨重签版本保留系统授权。不要从 build 目录直接启动 GUI helper，也不要把不同路径的副本当同一权限主体。

## 权限与诊断

```sh
agent-screen-recorder doctor --json
agent-screen-recorder authorize --interactive --timeout 120 --json
```

所有调用者均通过 LaunchServices 启动固定路径的 GUI helper，由它执行预检、系统请求和真实流验证。`doctor` 不弹权限、不打开设置；已经授权时会短暂采集真实帧（不保存文件），因此不要在不允许捕获的环境运行。只有显式 `authorize --interactive` 才主动请求授权，未生效时打开「隐私与安全性 → 屏幕与系统音频录制」，输出准确 App 名称和路径；自动复查，至多重启一次空闲 helper 再用真实流复验。是否准许由系统和用户决定，工具不修改 TCC 数据库。

系统页面可能使用「屏幕与系统音频录制」名称，但本工具的音频和麦克风采集都关闭。普通录屏及外部已授权输入日志无需开启辅助功能或输入监控权限。可选原生鼠标监听若不可用，有独立诊断及授权入口，不影响普通录屏。

## 录制

```sh
agent-screen-recorder windows --json
agent-screen-recorder start --window 123 --output "$HOME/Movies/window-demo.mp4" --duration 18 --tail 1 --fps 60
agent-screen-recorder status
agent-screen-recorder stop
```

`--window` 使用原生独立窗口过滤器，输出只有目标窗口内容，不露出后方桌面；初始窗口边界决定编码尺寸。`showsCursor=true` 交给系统捕获真实光标，不叠加绘制光标。移动到窗口之外的指针不会出现在该窗口画面中。窗口 ID 必须来自本次 `windows` 查询，并且窗口在屏幕上。请用真实机器验收系统光标及目标窗口组合；不要仅凭启动成功推断指针已编码。

也可录主屏或指定屏幕：

```sh
agent-screen-recorder displays
agent-screen-recorder start --output "$HOME/Movies/display-demo.mp4" --duration 10
agent-screen-recorder start --display 1 --output "$HOME/Movies/filtered.mp4" \
  --exclude-app org.example.overlay --exclude-window 456 --duration 10
```

排除 App 必须正在运行、窗口 ID 必须存在，找不到则失败。独立窗口模式不与屏幕/排除选项组合。录制只捕获一个系统光标。

`start` 返回 `ready` 必须同时收到录制开始回调和真实完整帧，不意味着 MP4 已完成。定时录制会自行停止，调用 CLI 退出不会打断会话。手动 `stop` 等待完成；最终 `completed` 才表示写入完成、时长为正、所有视频帧完整解码，且末帧实际到达媒体终点。没有录制时 `stop` 不会假报成功。

录制默认解码重编码收尾：保留真实帧顺序与时间间隔，实际编码重复末帧直到原生记录时长及单调时钟测得的录制终点，避免容器头有尾段而样本已提前结束。`--tail`（0–30 秒）额外持有最后真实画面，不重画指针。长视频会增加完成时间；超时明确失败并保留中间文件。帧率为请求值，实际帧交付仍取决于系统与负载。

## 可选指针事件

```sh
agent-screen-recorder pointer-doctor
# 仅当明确选择原生监听且诊断不可用时：
agent-screen-recorder pointer-authorize --interactive
agent-screen-recorder start --window 123 --output "$HOME/Movies/demo.mp4" --duration 18 \
  --pointer-output "$HOME/Movies/demo.pointer.json" --pointer-source native
```

`pointer-doctor` 先只读预检输入监控权限；未获权时直接拒绝，绝不创建可能触发系统提示的 tap。已获权才验证鼠标专用、只读 tap；原生监听不订阅键盘、不控制输入。仅 `pointer-authorize --interactive` 可请求「输入监控」，并显示准确 App 名称/安装路径。系统拒绝时返回明确错误。事件监听故障不能假报 sidecar 完整。

**外部在线事件入口已停用**：验收发现真实down/up漏收，只收到move，不能用于制作。`start --pointer-source external-authorized` 返回 `external_pointer_unavailable`；使用已验收的native轨道。独立真实日志继续使用下方离线导入。以下协议说明保留用于解释已有日志，不表示在线入口可用。

已获授权、正在执行真实输入的 Agent 可选择 `--pointer-source external-authorized`；从 `ready` 取 `pointerSessionID`，每次实际输入后提交事件，无需新增监听权限：

```sh
agent-screen-recorder pointer-event --session SESSION_UUID --event \
  '{"hostTimeSeconds":12345.25,"kind":"down","x":350,"y":240,"button":"left"}'
```

这里 `hostTimeSeconds` 是实际事件的系统单调时钟秒（如有效 Quartz 事件 timestamp/1e9，或经 timebase 换算的 mach_absolute_time），`x/y` 是 Quartz 全局屏幕左上原点的**点**，不是前一个鼠标位置或预定动作时间。工具用首个真实 complete 视频样本 PTS 的 `clockOriginHostSeconds` 对齐媒体秒，并按逐帧 screenRect/contentRect/scaleFactor 映射成视频像素。窗口移动/Retina 变化保留 `mappingSamples`；不要用 CLI ready 墙钟对齐，也不要默认其他运行时的 monotonic 与 Quartz 同源；提交前现场对照 host 时钟。可选 `targetWindowID` 必须来自实际事件接收窗口的证据，不能填计划目标。原生监听优先使用WindowServer标注的实际窗口；外部缺少该字段时使用窗口栈和可见工作区保守过滤，忽略Dock全屏合成容器，系统保留区不判为应用点击。实时入口应随实际事件及时调用；已有历史日志使用下面的离线入口，调用者先按原始证据校准坐标与媒体时钟。

```sh
agent-screen-recorder pointer-import --video "$HOME/Movies/demo.mp4" \
  --input /path/calibrated-real-events.json --output "$HOME/Movies/imported.pointer.json"
```

离线导入只校验公开格式、真实视频尺寸、完整媒体时长、有序事件及边界，不监听输入、不启动 GUI、不改视频；保留调用者的时钟和映射证据。输入需声明 `source: "external-authorized"`，来源真实性由提供日志的 Agent 负责。示例与完整字段见 [examples](examples/README.md)。任何 Agent 均可直接读写此格式。

独立窗口仅收目标窗口的鼠标活动；从窗口内开始的拖动可继续到外部，保留越界坐标及 `inside:false` 的松开事件，不能把坐标夹回窗口。录制结束仍按住时只在 `buttonsHeldAtStop` 记录真实状态，不伪造 up。事件限制在捕获区间，额外静止尾段不伪造输入。原视频始终保留系统光标，sidecar 可用于独立可编辑渲染。

## 机器结果与故障

stdout 始终是一行 JSON（`--json` 可显式写出），失败退出码 1。字段包含 `schemaVersion`、`ok`、`code`、App 身份及状态/输出详情。区分 `permission_required`、`permission_not_granted`、`desktop_unavailable`、`no_frames`、`write_failed`、`output_exists`、`command_timeout` 等；无法枚举时附实际失败信息，不臆测已授权。

最终输出以独占方式预留，绝不覆盖已有文件。中间 MP4 使用独立隐藏文件名，录制失败不当作成品。进程被强制杀死时保留未完成文件，并在下次启动报告 `interrupted`；不要把残留的零字节预留文件当成视频。请求接受后立即移出待处理队列，helper 重启不会自动重新执行已接受的授权/录制命令，而是返回 `operation_interrupted`；调用方先检查状态，再显式决定是否重试。真实帧诊断及授权重启后的真实流复验最多使用15秒原生操作预算，不继承交互授权的数分钟等待预算；卡住则明确失败退出helper并保留证据。当前没有取消已接受系统授权的公开接口，`stop` 只停止录制，不能冒充取消授权；不要连续提交长超时授权请求。空闲 helper 自动退出，不在开机时常驻。

状态与本地请求只保存在 `~/Library/Application Support/Agent Screen Recorder`，目录 0700、JSON 0600；不使用网络端口。输出路径由当前桌面用户决定。

## 无屏幕验证

```sh
scripts/test.sh
```

测试只编译独立测试程序，运行参数/身份、合成媒体、伪长容器头回归、完整尾帧、指针坐标/时钟/拖出界状态、离线导入及不覆盖检查；不替换签名 App。不安装、不启动 GUI helper、不申请权限、不录真实桌面。真实授权、窗口边界、系统指针和拖动流畅度仍需对同一产物独立验收。

可复跑的安装→授权→真实帧→窗口及事件→渲染→尾段验收入口见 [examples/README.md](examples/README.md)。

API 依据：[SCRecordingOutput](https://developer.apple.com/documentation/screencapturekit/screcordingoutput)、[SCRecordingOutputDelegate](https://developer.apple.com/documentation/screencapturekit/screcordingoutputdelegate)、[SCStreamFrameInfo](https://developer.apple.com/documentation/screencapturekit/scstreamframeinfo)、[Quartz CGEvent](https://developer.apple.com/documentation/coregraphics/cgevent)。
