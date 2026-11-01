import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url));
const cfg=JSON.parse(fs.readFileSync(path.join(dir,'effects.json')));
const data=JSON.parse(fs.readFileSync(path.join(dir,'pointer-events.json')));
if(data.schemaVersion!==1||data.timebase!=='media-seconds'||data.coordinateSpace!=='video-pixels-top-left')throw Error('不支持的事件格式');
if(!Number.isInteger(data.width)||!Number.isInteger(data.height)||data.width<=0||data.height<=0)throw Error('无效视频尺寸');
if(!/^#[0-9a-f]{6}$/i.test(cfg.color))throw Error('颜色须为六位十六进制');
for(const key of ['clickDuration','clickRadius','holdRadius','pressDuration','releaseDuration','releaseRadius','strokeWidth','duration'])if(!Number.isFinite(cfg[key])||cfg[key]<=0)throw Error(`无效配置 ${key}`);
if(typeof cfg.enabled!=='boolean')throw Error('enabled须为布尔值');
if(!Number.isFinite(cfg.holdOpacity)||cfg.holdOpacity<0||cfg.holdOpacity>1)throw Error('holdOpacity须介于0和1');
let last=-Infinity;const pressed=new Set();const pairs=[];
for(const e of data.events){
 if(!Number.isFinite(e.t)||e.t<0||e.t>cfg.duration||e.t<last||!Number.isFinite(e.x)||!Number.isFinite(e.y)||!['move','down','up'].includes(e.kind)||!['none','left','right','middle','other'].includes(e.button)||(e.kind!=='move'&&e.button==='none'))throw Error('无效或乱序事件');last=e.t;
 if(e.kind==='down'){if(pressed.has(e.button))throw Error('重复按下');pressed.add(e.button);pairs.push({down:e});}
 if(e.kind==='up'){if(!pressed.has(e.button))throw Error('无对应按下的释放');pressed.delete(e.button);pairs.findLast(p=>p.down.button===e.button&&!p.up).up=e;}
}
if(pressed.size)throw Error('按下事件缺少释放；删除动作时请删对应down/up');
const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><script src="gsap.min.js"></script><style>html,body{margin:0;width:${data.width}px;height:${data.height}px;overflow:hidden;background:#f4f4f4}#root{position:relative;width:${data.width}px;height:${data.height}px}video,svg{position:absolute;inset:0;width:${data.width}px;height:${data.height}px}circle{fill:none;stroke:${cfg.color};stroke-width:${cfg.strokeWidth}}</style></head><body><div id="root" data-composition-id="main" data-width="${data.width}" data-height="${data.height}" data-fps="60" data-duration="${cfg.duration}"><video id="source" src="source.mp4" data-start="0" data-duration="${cfg.duration}" muted playsinline></video><svg id="effects" viewBox="0 0 ${data.width} ${data.height}" style="display:${cfg.enabled?'block':'none'}">${pairs.map((p,i)=>`<g id="hold${i}" opacity="0"><circle r="${cfg.holdRadius}" style="fill:${cfg.color};stroke:none"/></g><g id="pulse${i}" opacity="0"><circle r="${cfg.holdRadius}"/></g><g id="release${i}" opacity="0"><circle r="${cfg.holdRadius}"/></g>`).join('')}</svg></div><script>
const cfg=${JSON.stringify(cfg)},events=${JSON.stringify(data.events)},pairs=${JSON.stringify(pairs)};
const tl=gsap.timeline({paused:true});
// 每次seek均由确定的CSS/SVG tween恢复；不依赖播放回调或实时输入。
for(let i=0;i<pairs.length;i++){
 const {down:d,up:u}=pairs[i]; const drag=u.t-d.t>.35;
 const pulse='#pulse'+i,hold='#hold'+i,release='#release'+i;
 tl.set([pulse,hold],{x:d.x,y:d.y},d.t);
 tl.fromTo(pulse,{opacity:.95},{immediateRender:false,opacity:0,duration:drag?cfg.pressDuration:cfg.clickDuration,ease:'power1.out'},d.t);
 tl.fromTo(pulse+' circle',{attr:{r:cfg.holdRadius*.7}},{immediateRender:false,attr:{r:drag?cfg.holdRadius*1.65:cfg.clickRadius},duration:drag?cfg.pressDuration:cfg.clickDuration,ease:'power1.out'},d.t);
 if(drag){
  tl.set(hold,{opacity:cfg.holdOpacity},d.t);
  for(const e of events)if(e.kind==='move'&&e.t>=d.t&&e.t<u.t)tl.set(hold,{x:e.x,y:e.y},Math.max(d.t,e.t-.00001));
  tl.set(hold,{opacity:0},u.t);
  tl.set(release,{x:u.x,y:u.y},u.t);
  tl.fromTo(release,{opacity:.95},{immediateRender:false,opacity:0,duration:cfg.releaseDuration,ease:'power1.out'},u.t);
  tl.fromTo(release+' circle',{attr:{r:cfg.holdRadius}},{immediateRender:false,attr:{r:cfg.releaseRadius},duration:cfg.releaseDuration,ease:'power1.out'},u.t);
 }
}
tl.to({}, {duration:.001},cfg.duration-.001);
window.__timelines={main:tl};
</script></body></html>`;
fs.writeFileSync(path.join(dir,'index.html'),html);
console.log(JSON.stringify({pairs:pairs.length,events:data.events.length,duration:cfg.duration,enabled:cfg.enabled}));
