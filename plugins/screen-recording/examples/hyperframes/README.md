# 独立可编辑指针叠层

该示例从已完成实际渲染、整层关闭、改色、删除单击及无事件残环检查的模板提取；这里改为读取 sidecar 宽高，不包含任何验收原片、真实日志或第三方运行库。录屏工具完全不依赖此目录。

在一个新编辑目录复制 `compile.mjs`、`effects.json`，并放入：

- `source.mp4`：已核完整尾帧的原视频副本；原始文件另存不动。
- `pointer-events.json`：真实 sidecar，媒体秒与视频像素已经验证。不能把上级说明用 pointer.json 当真实证据。
- `gsap.min.js`：从已安装的 GSAP 3.14.2 的 `dist/gsap.min.js` 复制，保留其许可证头。

示例依赖 Node >=22、GSAP 3.14.2、HyperFrames CLI 0.8.196；独立媒体验收另需 FFmpeg/ffprobe。这些均不是录屏工具依赖。配置 `effects.json` 的 `duration` 等于视频真实时长，需覆盖最后释放扩散；建议录制时预留 `--tail 1`，不把效果截在文件外。

```sh
node compile.mjs
hyperframes preview .
hyperframes render . --fps 60 --workers 1 --quality delivery --output preview.mp4
```

`effects.json`：`enabled:false` 关闭整个效果层；`color` 改色；按住阶段是无描边的低透明度实心圆，`holdOpacity` 在0–1之间可调（默认0.2）；点击与释放仍为涟漪。半径/时长/线宽独立可调。`pointer-events.json` 单独保存动作；删一个单击要删其对应 down/up，后续拖动保留。编译器拒绝乱序、无对应释放、缺失 up 及越过视频时长的事件。录制结束仍按住时应先保留源证据并排除该不完整动作，不得伪造释放。

动作语义：短 down/up 产生单击涟漪；长按触发脉冲并用 move 驱动低透明度实心按住圆；真实 up 触发释放扩散。SVG 组初始透明，所有未来 `fromTo` 使用 `immediateRender:false`；扩散修改 circle 半径以保持中心稳定。原视频箭头不重画。

验收时实际渲染基线、关层、改色、删单击四版；检查按下前及全部淡出后无左上角残环；删单击不能破坏拖动/释放。抽帧比较叠层中心和原箭头热点，并对渲染片执行上级末帧检查。不能用增加帧密度恢复原片缺失的动作帧。

本仓库只自检了泛化编译器，当前新候选的真实事件→渲染仍须独立验收；不会把模板旧素材的通过当新素材通过。
