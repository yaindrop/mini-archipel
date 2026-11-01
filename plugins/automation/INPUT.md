# 通用原生输入

本接口随 Automation 1.2 提供。输入由现有 Automation 伴随 App 直接执行，沿用其 Bundle ID、持续签名和辅助功能权限；不启动另一套输入 App，不依赖旧工具或录屏插件。录屏与独立核图仍使用 screen-recording。

## 能力与边界

| 既有有效能力 | 正式承接 | 验证要求 |
| --- | --- | --- |
| move/click/doubleClick/middleClick | 同名动作；从实际指针开始，约60Hz，可控接近与短停 | 实际终点误差小于2.5屏幕点，真实down/up |
| 五次缓动 | `smootherstep`；同时提供已实录的三次`smoothstep`和`linear` | 节拍、端点、时长、missed ticks |
| 带相对时间points的drag | 同名动作，路径时间严格递增；4秒正常约240步 | 持续按住、到达、deadline与异常释放 |
| 按下/按住/释放 | click/drag内部生命周期；新增有界`mouseHold`和key的hold_seconds | 不允许跨请求遗留按住；只能释放本次拥有的键钮 |
| text/key/修饰键组合 | Unicode文本、扩充键名/虚拟键码、组合键 | 实际编辑域/安全域拒绝，日志不记录文本正文 |
| fresh目标/前台/几何/命中/编辑域 | 任意显式bundle_id+pid+window_id+观察frame | 无硬编码App或工作区；变化立即拒绝 |
| 180ms校验lease/10Hz续验/AX通知 | 保留，与动作调度分离 | 慢AX不能延长过期lease，失效释放自有输入 |
| STOP/信号/取消/硬超时/独占/单用ID | 复用durable jobs与桌面锁；补input-stop | 默认15秒，可显式设1–120秒，释放后才落盘，不重放 |
| 旧动作后自动AX全文快照 | 改为调用方显式核真实状态及录屏插件同流PNG，不默认采集通用窗口AX正文 | 观测方式调整；不声明等同AX全文导出 |
| 实际post边界、单调时间、实际指针、结果日志 | 每请求独立events.jsonl/result.json | posted不代表UI已生效，必须独立核图/核状态 |
| 旧场景SHA、固定路径/标签、限定App和400点ROI | 移除；由节点鉴权/allow_control和通用目标范围承接 | 无外部自有实现依赖 |
| 旧动作表不支持的right click/scroll | 新增rightClick/scroll，原生像素滚轮 | 验证真实应用响应，不只统计post |
| 屏幕/窗口与Retina坐标 | 显式space、unit、display_id | 实际显示器比例；跨屏像素歧义拒绝，使用points |

指针动作可在target追加调用者刚观察的 `hit_role`（1–100 UTF-16单位，精确AXRole）和 `hit_text`（1–1000单位，实际命中及最多4层祖先title/description/value需含该子串），用于承接可选控件核验；不写期望或实际文本到事件日志。两者只适用于明确的指针动作，不接受在text/key/activate中无效附带。省略时只验证应用/窗口/焦点/几何与命中PID，不能当正确控件标签已核验。

不是所有应用都承诺兼容。辅助功能未开放、受保护输入、目标拒绝、窗口焦点/几何不确定、观察过期、已有物理按钮或修饰键按住都明确失败，不猜目标、不替用户解除按住。`SIGKILL`、系统崩溃不能保证用户态清理；正常取消/STOP/超时使用协作释放并保留真实结果。

## 稳定调用

继续使用现有 `desktop-automation submit/get/wait/cancel` 和 Console `/api/plugins/automation/actions/...`。由负责产品操作的 Agent/ZCode 实际调用，不由旁路伪造动作证据。

- `input-info`：静默返回动作/坐标/键名协议、真实权限、运行中的普通GUI App、窗口列表、当前前台应用的准确聚焦窗口及display信息；不激活App、不请求权限、不post。
- `activate`：使用与输入相同的显式目标及 `action:{"kind":"activate"}` 提交；只在execute模式激活并提升该窗口，核验实际前台/聚焦/几何。已正确聚焦时直接核验；需要切换时请求应用激活，AXRaise仅辅助并保留实际返回码，最终以前台/准确聚焦窗口/几何复验决定成功。info和preflight不激活，失败不自动换App。
- `input-log {request_id,offset}`：读取本次释放后生成的脱敏日志，每页最多256条，返回next_offset/total_events；不是任意路径读取。
- `submit`：`operation:input`，显式`mode:preflight|execute`，一请求一动作；同ID同内容查询复用，变参冲突。
- `get/wait`：查询同一个durable request ID；输入成功仅表示本次实际post已完成且自有键钮已释放。
- `cancel`：取消指定输入，协作释放；不撤销已发生效果。
- `input-stop {stopped:true}`：持久停止当前与后续输入；`stopped:false`只允许新的请求，不重放任何旧任务。

请求形状：

```json
{
  "request_id": "one-observed-action-001",
  "operation": "input",
  "mode": "execute",
  "timeout": 15,
  "target": {
    "bundle_id": "com.example.app",
    "pid": 123,
    "window_id": 456,
    "frame": {"x": 240, "y": 30, "width": 1440, "height": 960},
    "observed_at_ms": 0
  },
  "coordinates": {"space": "window", "unit": "points"},
  "action": {"kind": "click", "x": 300, "y": 200, "move_seconds": 1, "settle_seconds": 0.2}
}
```

示例的PID/窗口/时间/位置均是占位，必须从真实input-info和控件观察刷新，不能照抄。默认smoothstep，旧五次曲线用`easing:smootherstep`；双击是`doubleClick`，不能用它机械替换单击。

`drag.points`为同一坐标语义下的`[{t:0,x:...,y:...},...,{t:4,x:...,y:...}]`。`scroll`需x/y及非零delta_x/delta_y（像素滚轮，正负方向须在目标应用实测）；`key`用key或key_code二选一及modifiers；`text`用text字段，最多16000 UTF-16单位，安全文本域拒绝；默认每次按Unicode标量发送，`text_chunk_units:1..20`允许显式分块，保证不拆开代理对。默认15秒，`timeout:1..120`为本动作硬上限。事件派发前按路径/停顿/按住/文本块估计预算，留250ms余量，超过则拒绝并要求明确调整参数；长内容和慢演示不能仅改超时而绕过参数上限。

| 参数 | 默认 | 有界范围 |
| --- | --- | --- |
| move_seconds | 1秒 | 0–30秒；0明确使用即时移动 |
| settle_seconds | 0.2秒 | 0–5秒 |
| hold_seconds | 点击0.08秒、按键0.06秒、mouseHold 1秒 | 0.01–60秒 |
| drag.points | 显式提供 | 2–1000点；t从0严格递增，终点0.1–60秒 |
| scroll.duration | 0.5秒 | 0.05–60秒；每轴delta为-10000..10000像素整数且至少一轴非零 |
| text_chunk_units | 1 | 1–20 UTF-16单位；单个代理对保留为2单位 |

较长动作需显式增加timeout，仍受180ms校验租约、STOP及焦点/窗口守卫约束。分多请求时每次刷新目标并核真实应用响应，不自动续传失败动作。

`screen/points`为Quartz全局左上原点屏幕点，支持负坐标显示器；`window/points`原点为当前窗口frame左上。`pixels`是实际显示器backing像素，不是缩放截图像素，必须给真实display_id；窗口跨多个显示器时拒绝window/pixels，改用points。记录实际比例，不以Retina=2写死。

## CLI与结果核验

目标节点本地入口（不会因查询请求权限或激活窗口）：

```sh
~/.local/libexec/mini-archipel-desktop/desktop-automation input-info
~/.local/libexec/mini-archipel-desktop/desktop-automation submit < observed-input.json
~/.local/libexec/mini-archipel-desktop/desktop-automation wait one-observed-action-001 --timeout 20
~/.local/libexec/mini-archipel-desktop/desktop-automation input-log one-observed-action-001 --offset 0
printf '%s' '{"stopped":true}' | ~/.local/libexec/mini-archipel-desktop/desktop-automation input-stop
```

远程调用使用已有 `desktopctl.py --url CONSOLE --host NODE input-info|submit|get|wait|cancel|input-log|stop-input|resume-input`，令牌从ARCHIPEL_TOKEN读取。Console REST路径为 `/api/plugins/automation/actions/input-info|submit|get|cancel|input-log|input-stop`，body加host，submit请求放request字段；仍受插件启用、节点与Console鉴权、allow_control检查。input-info/log/get/preflight是只读，execute/activate/STOP需allow_control；经过严格验证的input不要求allow_scripts，任意脚本仍要求它。

先查info，取真实窗口目标；目标观察最多120秒且几何变化立即拒绝。必要时明确activate，再重新查info/控件观察，最后preflight或execute。不要复用示例坐标、旧PID或把截图像素直接当屏幕点。协议JSON随伴随App打包，由info.request_schema发布；实际的目标新鲜度、几何/权限/编辑域及预算检查仍由运行时执行。

`input_posted`表示实际post调用返回，`gui_effect_verified`始终false。以原request ID查询结果及分页日志，确认owned_input_at_exit的buttons/keys为空；再通过目标状态或录屏插件同流PNG独立核UI效果。失败的events_may_have_been_posted、activation_requested与ui_side_effects_may_have_occurred可能表明已有部分效果；取消不会撤销。STOP对活跃任务锁存取消，即使立即resume也不能复活动作。相同ID不能改参或再次派发；不确定时先读原记录，不自动换ID重试。

打开或关闭原生对话框可能在输入已经产生效果后触发焦点守卫。例如 Return 关闭子面板后，结果可能为 `input_stopped`，同时保留可能已派发和自有键已释放的回执。此时应保留原结果，独立核图或核真实状态，确认释放后刷新目标，再执行下一独立动作；不要重发原按键或把停止解释为零效果。

离线检查只验证构造、协议和调度，不能证明App接收。跨App真机验收须单独覆盖普通编辑器、计算器及目标产品的实际响应、显式切换、取消、权限拒绝与坐标；没有实测的应用不声明兼容。

## 三App迁移基线验证（2026-11-01）

以下保留1.2.2的三App基线；后续1.2.4调度与快捷键修复的真实整链结果见末节。该基线固定原生实现为 `3c121ce7a4f03228425fbf6db4536c080640861f` / Automation App 1.2.2，沿用原 Bundle ID 与持续签名。Agent 0.12.0、Console 0.14.0 基座为 `3c7f857`；后续文档变更不替代已测二进制身份。上方能力对照中的动作、安全生命周期和通用化已进入该正式实现，旧源码与 App 保持留存。

| 验证层 | 已核结果 |
| --- | --- |
| 离线协议、运输与取消 | 49项Python；Swift真实CGEvent构造但禁止系统派发的基础测试与12组负例；实际双架构App构建、签名及中英名称 |
| Agent与Console | Rust 36项、实际运输6项；Console 145项及覆盖率/构建/审计。原完整浏览器153项为150通过、3失败；定位任务完成与弹层进场的测试就绪问题后，两个受影响用例在三引擎6/6通过，不声称最终版本另跑153项全部通过 |
| Calculator | 实际点击0→7；后台激活及已聚焦时的准确窗口确认；真实GUI预检/激活/执行三请求均完成 |
| TextEdit独立测试文档 | Unicode文本、组合键、双击选词、四秒拖动、右键、滚动、按住取消及自然一秒按住/释放；实际状态与原生事件核验 |
| Flowbit独立副本 | 原生文件子窗与嵌套路径面板、Unicode路径、实际加载独立副本；内部侧栏四秒拖动宽度360→440，240个原生drag、实际按住4.0004865秒，自有输入释放 |
| 停止与坐标 | STOP拒绝新执行；恢复后旧取消ID只复用回执且日志不变；实际screen/pixels @1x。关键步骤同流PNG晚于输入结束，输入日志与原生轨时钟匹配 |

真实失败原件保留：已有准确焦点时不支持AXRaise的误报已修；发现的原生聚焦子窗不在AXWindows而被拒的候选不一致已修。关闭子面板时焦点守卫仍可能诚实返回 `input_stopped` 并保留已发生效果，不能改写成每动作都完成。

中键在目标App中的响应、Retina/多屏、撤权/系统保护输入，以及长文本上限的真实应用响应未完整实测，不补成通过；自然按住测试也不代表特有长按菜单语义。静默doctor的系统聚焦查询仍有 `-25204` 诊断限制，保持“检测失败”，不以trusted布尔值替代verified；针对目标窗口的实际输入验收与此分别记录。旧动作后AX全文导出改为显式状态及同流PNG核验的差异保持，不声明全文采集等价。

旧 Demo Input 的源码、构建与协议参考及 App 均不因本次替代自动删除。先呈现本对照与验证边界，删除仍须明确批准；保留原指纹及失败/媒体证据。

## 聊天回合内委托输入

工具包1.2.3将聊天的等待与实际桌面派发分开：聊天保留自身worker互斥及同ID回执锁，GUI锁仅覆盖准备、保存回执与实际发送，等待模型回复时释放。非聊天动作仍使用原桌面worker锁，实际输入继续持GUI/native独占与全部目标、STOP、取消、超时及释放守卫。因此外层chat仍running时，受托模型可以经同插件提交input；不能靠取消外层observer、删除锁或旁路旧工具来获得输入资格。

新增多进程真实worker/文件锁回归覆盖该嵌套路径、发送期与输入期的并发写拒绝、STOP协作取消、旧ID不重放，以及发送确认不明时的回执锁；全Python回归为51项。此调度补丁不改变App1.2.2、Agent或Console二进制。取消chat等待仍只停止observer，不停止App模型；正常停止当前模型回合须使用应用自身的Stop入口，并确认终态及无活跃工具后再安装或交机。

## 快捷键与持键诊断

1.2.4中，聊天发送与原生输入共用自有按键控制。Command快捷键显式按下并释放自己的modifier，结束、异常及正常信号取消只清理本次拥有的键；已有外部持键时拒绝，不发送补偿keyup。快捷键前后状态与owned清单、关联request_id、sender PID和逐事件时间写入不含文本的chat-input回执，正常返回也附input_cleanup。

input-info及输入拒绝的input_state列出HID/combined flags、左右8个修饰键的两域状态、观察进程与当前请求ID，并附最近记录的本工具聊天动作。两域是聚合状态，包含已投递的HID事件，不是物理键盘或历史来源的独立证明；最近动作也不能直接当成持键owner。发现非中性状态应保回执查前后链路，不能依据模糊“物理键按住”文案归责或忽略守卫。故障恢复需要明确范围、完整自有按下/松开及前后采样，不作为业务输入绕过STOP或外部持键保护的入口。

升级验收必须先走一个真实短闭环：正常chat发送→模型经同插件委托真实原生输入→输入前后外chat仍running→实际状态/回执核验→模型正常结束。模块单测或仅激活成功均不能代替此链路通过。

### 1.2.4真实整链结果（2026-11-01）

固定实现 `2e4db12048e4bf6e21063db5cf93232e847013cd` / App与工具包1.2.4 已完成此短闭环：外chat在模型委托输入前后均为running、desktop_busy=false，期间未取消observer；模型实际通过同插件CLI完成Calculator激活与一秒move，两个输入均completed、自有键钮为空。61个实际move与原生轨匹配，晚于结束的同流PNG核见目标与指针。模型正常回复结束后，两域8个modifier仍无unsafe状态；发送器的关联请求ID/PID、按键前后中性状态与owned清单有原始回执。

原先两层等待锁自阻与随后修饰键拒绝的真实失败继续保留。旧发送器末尾keyup留Command标志的构造缺陷已证并修复；历史残留的唯一进程没有排他证明，不归责为真人持键。此前一次明确授权的完整左Command按下/松开恢复有独立前后采样，不作为业务输入的通用解锁入口。正式镜头及三片成片另行验收，不由该短链通过代填。
