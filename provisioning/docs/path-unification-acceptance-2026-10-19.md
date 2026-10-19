# 路径统一验收 · 2026-10-19

本记录对应 [scripts/README](../scripts/README.md) 与
[fan-control 部署布局](../../fan-control/README.md)。承接
[命名统一验收](archipel-rename-acceptance-2026-10-19.md)，本轮收尾两个
遗留命名空间并清剿节点历史残留。

## 变更一：风扇服务系统级路径

| 旧 | 新 |
| --- | --- |
| `/Library/MacMiniFanControl/` | `/Library/MiniArchipel/FanControl/`（与既有状态目录合并） |
| `/Library/Logs/MacMiniFanControl/control.log` | `/Library/Logs/MiniArchipel/fan-control.log` |
| `/Library/Logs/MacMiniFanControl/plugin.log` | `/Library/Logs/MiniArchipel/plugin.log` |
| `system/com.macmini.fan-control` | `system/local.miniarchipel.fanctl` |
| `/etc/newsyslog.d/macmini-fan-control.conf` | `/etc/newsyslog.d/miniarchipel-fanctl.conf` |

fanctl 版本 1.5.0-archipel.2 标记本次路径变化；来源链（上游 → m6 →
archipel 两层补丁 + SHA256SUMS）经 `check-source.sh` 全量复核。Agent
默认路径（`config.rs`、`fan.rs`、`install.sh` 模板）随行。两台 mini 由
`fan-control/deploy/migrate-legacy-paths.sh` 以 sudo 一次性迁移：停旧
守护、交还 SMC、合并目录、换定义、起新 label 并断言温度回读。

## 变更二：mini-ci 命名空间并入 mini-archipel/ci

| 旧 | 新 |
| --- | --- |
| `~/.local/libexec/mini-ci/` | `~/.local/libexec/mini-archipel/ci/` |
| `~/.local/state/mini-ci/` | `~/.local/state/mini-archipel/ci/` |
| `~/.local/share/mini-ci/` | `~/.local/share/mini-archipel/ci/` |

`MINI_CI_*` 工作流输入与环境变量名**保留**：它们是四个仓库钉住引擎的
跨仓库接口，改名会破坏下一次 re-pin 前的旧引擎调用。节点迁移脚本
`provisioning/scripts/migrate-ci-namespace.sh` 在三处旧路径留下过渡软链，
旧钉住引擎经默认路径解析继续可用；**待四仓库全部 re-pin 到本轮及以后的
引擎提交后删除软链**（未关闭项）。

## 变更三：版本与残留

- Console 0.11.0 → 0.12.0、Agent 0.9.0 → 0.10.0（重命名与路径统一的
  部署标记）。
- 节点残留清剿（激进）：`~/.local/libexec/*.previous*`、
  `~/Library/LaunchAgents/*.plist.previous*`、`~/.cache/` 的
  20261017/18 部署包、`mini-archipel-source.tgz`、
  `mini-archipel-migration/` 全部删除（约 570MB）；三处过渡软链与
  `~/.config/flowbit-ci*`（Flowbit 品牌的活配置）保留。

## 实施与验证（待补）

| 检查 | yd-mini | yd-mini-2 | yd-mbp-tart | yd-mbp-tart-2 |
| --- | --- | --- | --- | --- |
| 风扇守护运行于 local.miniarchipel.fanctl | 待补 | 待补 | 不适用 | 不适用 |
| `/Library/MiniArchipel/FanControl/` 就位、旧目录消失 | 待补 | 待补 | 不适用 | 不适用 |
| 温度/转速回读正常 | 待补 | 待补 | 不适用 | 不适用 |
| mini-archipel/ci 三目录就位 + 过渡软链 | 待补 | 待补 | 待补 | 待补 |
| Agent 0.10.0 上报 | 待补 | 待补 | 待补 | 待补 |
| 残留清剿完成 | 待补 | 待补 | 待补 | 待补 |

## 实测证据（待补）
