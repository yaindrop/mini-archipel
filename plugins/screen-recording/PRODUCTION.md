# 录制与逐步核图

权威实现完全位于本插件目录。生产使用native轨道；外部在线输入因真实button事件漏收而明确禁用，离线真实日志导入仍可用。

Console动作入口 `/api/plugins/screen-recording/actions/<action>` 沿用Console鉴权。所有请求带 `host`，令牌从既有私有配置/环境读取，不写URL或日志。

1. `windows` 列真实窗口，含id、bundleID、title、pid、onScreen与frame（Quartz屏幕点）。只选择实际确认的目标。
2. `start`：`{"host":"node","request":{"request_id":"UUID","window":238,"duration":360,"tail":1,"pointer_source":"native"}}`。同ID同参数复用，变参冲突；收到 `code:ready` 后才执行产品动作。ready要求writer-start与真实完整帧，带clockOriginHostSeconds。
3. 每个关键动作后 `snapshot`：`{"host":"node","recording_id":"录制UUID","request_id":"此核图步骤UUID"}`。PNG来自该录制stream最新真实complete帧，不开第二个流、不重画；返回snapshotOutput、recordingOutput、hostTimeSeconds、mediaTimeSeconds、clockOriginHostSeconds、windowID、pid、width、height、bytes。媒体时间是该帧PTS减首帧PTS；调用者应与动作时钟核对，不能假设请求墙钟就是画面时间。同snapshot UUID重试复用已保存回执，变recording ID拒绝。
4. `artifact`：`{"host":"node","recording_id":"截图UUID","kind":"snapshot","offset":0}` 下载 `<截图UUID>.snapshot.png`；录像用录制UUID和kind video，鼠标JSON用kind pointer。返回hex编码、offset/next_offset/total_bytes，每块至多1MiB。完整取回后校验大小，不把单块视为完整文件。
5. `stop` 只表示提交停止请求。持续 `status` 等真实completed后取原MP4和sidecar；关闭网页/禁用插件不会取消已接受录制，不用新UUID盲重试。失败保原片/partial与回执。

CLI同样可用：`agent-screen-recorder snapshot --output /path/new.snapshot.png`，仅接受活动录制的真实完整帧，PNG/元数据均不覆盖已有文件。普通录屏不需要输入监控；只有native鼠标轨道才需要，按工作台显式请求并实际复验。
