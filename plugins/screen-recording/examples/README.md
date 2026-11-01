# 复跑入口

在已允许采集的 macOS 15+ 本地桌面执行。输出均选不存在的新路径。示例 JSON 是说明数据，不是真实输入证据。

1. `scripts/build.sh && scripts/install.sh`：安装固定身份。已有安装时先停止录制，再 `scripts/install.sh --upgrade` 完整备份并正常迁移旧路径；回滚用 `scripts/install.sh --rollback BACKUP_DIRECTORY`，不重置系统权限。
2. `agent-screen-recorder identity` → `doctor`。如返回 `permission_required`，显式运行 `authorize --interactive`，在系统页面批准准确的新 App，再由工具取真实 complete 帧验证。
3. `windows` 取本次目标窗口 ID。准备可见、对比清晰的合成窗口：按钮点击变色、可拖动块及目标框。不要用真实聊天/桌面当示例。
4. 需要原生事件时先 `pointer-doctor`，确需新增权限且同意后才运行 `pointer-authorize --interactive`。然后：

   ```sh
   agent-screen-recorder start --window 123 --output "$HOME/Movies/demo.mp4" \
     --duration 18 --tail 1 --fps 60 \
     --pointer-output "$HOME/Movies/demo.pointer.json" --pointer-source native
   ```

5. 等 `ready` 后，用真实系统鼠标靠近按钮→点击变色→连续拖块→松开→静止。`status`/`stop --timeout 120` 等待最终 completed；保存原始 JSON 回执。外部已授权输入可换 `external-authorized`，实际动作后用 `pointer-event` 及时提交全局屏幕点及 host 秒；如已有历史输入日志，则校准成媒体秒/视频像素后用 `pointer-import`。
6. 将原 MP4 和 sidecar 交给 [独立可编辑渲染示例](hyperframes/README.md)，按其入口运行 `node compile.mjs` → `hyperframes preview .` → `hyperframes render . --fps 60 --workers 1 --quality delivery --output preview.mp4`。录屏程序不内置 HyperFrames，也不修改原视频；渲染时保留原视频层，把事件光效放可编辑的独立层。不能把示例坐标当实际指针轨迹。
7. 核对原片与渲染片的真实终点和尾段。运行下列独立检查（ffprobe/ffmpeg 仅是验收依赖，产品无需安装）：

   ```sh
   # EXPECTED 用 stop 回执的 durationSeconds，须包括额外 --tail。
   python3 tests/media_timeline.py "$HOME/Movies/demo.mp4" EXPECTED
   ffmpeg -v error -i "$HOME/Movies/demo.mp4" -map 0:v:0 \
     -enc_time_base demux -fps_mode passthrough -f null -
   ```

   除元数据外，还需抽取接近终点的实际帧，确认末尾可解码、画面静止、最终落点正确；亲看单一真实系统箭头、点击变色、连续拖动和无桌面外露。sidecar 的 down/up 与编码帧点击应对齐，拖出窗口后的 up 不丢失；额外尾段内不能出现虚构事件。渲染片独立重复末帧检查。

# 公开 sidecar v1

必填：`schemaVersion:1`、视频像素 `width/height`、`coordinateSpace:"video-pixels-top-left"`、`timebase:"media-seconds"`、`source:"native"|"external-authorized"`、`events`。

事件：`{t,kind:"down"|"move"|"up",x,y,button:"left"|"right"|"middle"|"other"|"none"}`。`none` 仅用于不按键移动；`inside` 可选，工具实时生成时提供；`targetWindowID` 可选，必须对应实际事件接收者。原生事件来自系统标注窗口，外部来源不得用计划目标冒充实际接收者。`t` 有序且处于实际捕获区间，视频左上原点，坐标可因拖出界而为负或超出尺寸。

工具可添加 `sessionID`、`clockOriginHostSeconds`、`durationSeconds`、`captureDurationSeconds`、`captureWindowID`、`mappingSamples`、`buttonsHeldAtStop`。映射样本为 `{hostTimeSeconds,screenPointsTopLeft:[x,y,width,height],videoPixelsTopLeft:[x,y,width,height]}`，记录几何变化。离线来源可另加原始单调时钟/坐标转换/编码帧校准证据；导入会保留，不会声称重新观察到事件。
