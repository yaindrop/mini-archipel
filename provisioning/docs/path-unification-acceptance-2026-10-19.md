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
| 风扇守护运行于 local.miniarchipel.fanctl | 通过（17:13） | 通过（17:13） | 不适用 | 不适用 |
| `/Library/MiniArchipel/FanControl/` 就位、旧目录消失 | 通过 | 通过 | 不适用 | 不适用 |
| 温度/转速回读正常 | 通过（41.2°C / 2166rpm） | 通过（35.1°C / 停转） | 不适用 | 不适用 |
| mini-archipel/ci 三目录就位 + 过渡软链 | 通过（3 链） | 通过（3 链） | 通过（3 链） | 通过（3 链） |
| Agent 0.10.0 上报 | 通过 | 通过 | 通过 | 通过 |
| 残留清剿完成 | 通过 | 通过 | 通过 | 通过 |

## 实测证据（2026-10-19 17:13–17:5x）

- 风扇迁移（sudo migrate-legacy-paths.sh）：两台守护以
  `local.miniarchipel.fanctl` 运行、program 指向新路径；旧
  LaunchDaemon plist 与 newsyslog conf 消失，仅剩 `miniarchipel-fanctl.conf`；
  fanctl 1.5.0-archipel.2 温度回读断言通过。
- 根级辅助服务（/Library/LaunchDaemons/local.miniarchipel.fan-control，
  供插件 socket）：初次脚本误判其在 LaunchAgents，两轮修正后经
  fix-fan-helper3.sh 重启到新路径；socket `{"op":"read"}` 两台均
  `ok:true, availability:"ready"`；Console /api/state 两台 mini 的
  fan-control 插件 `availability:"ready"`，VM 为 unsupported（设计如此）。
  migrate-legacy-paths.sh 已补上该 helper 环节防止复用遗漏。
- Agent 0.10.0（持久身份签名，identifier local.miniarchipel.agent）：
  四节点原子替换 + 重启，`--version` 与 Console 上报一致；Console
  0.12.0 banner 确认，4 仓库 runners 插件就绪。
- mini-ci 迁移：四节点三目录并入 mini-archipel/ci，旧位置 3 条过渡
  软链保留（旧引擎默认路径解析验证通过），16 个 runner `.env` 钩子
  路径更新。
- 残留清剿：四节点 `~/.local/libexec/*.previous*`（yd-mini 96 项，含
  16+5 个 console 目录）、`~/Library/LaunchAgents/*.plist.previous*`、
  `~/.cache/mini-archipel-*`（含 yd-mini 470MB migration 缓存）全部清零；
  复核 libexec 仅剩活物（agent 二进制、console、mini-archipel/、ci 软链、
  provisioning、firewall.sh）。
- 仓库：check-source.sh（含重生成的 SHA256SUMS 与两层补丁链）、
  provisioning unittest 44 项、console pnpm check 109 项、agent cargo
  test 16 项全部通过。

## 未关闭项（2026-10-19 晚间更新）

- ~~过渡软链~~：PR #7 合并（引擎 cba5d90）后，flowbit #842、
  flowbit-knowledge #33、in-frames #14 三个 re-pin PR 的 Quality 均在新
  引擎、新 mini-archipel/ci 路径上实际执行并通过并合并；四仓库全部钉
  cba5d90 后，四节点的三条 mini-ci 软链已删除。
- 钩子脚本补部署（2026-10-19 晚）：B1 只搬移了节点上的旧版钩子，其内部
  STATE 常量与 exec 路径仍指 mini-ci，软链删除后首轮真实作业会失败。已将
  仓库 cba5d90 版四个钩子原子替换到四节点（runner-policy.json 随迁），
  重启全部 14 个 runner 刷新钩子环境变量；本 PR 的 Quality 即为无软链、
  纯新路径下的全链验证。
- `MINI_CI_*` 跨仓库输入名：保留（接口语义），下次协调 re-pin 时评估。
- 两台 mini `/Library/LaunchDaemons/.legacy-*` 回滚 plist（root 属主）：
  待下次 sudo 维护删除。
