# mini-ops / fleet 命名统一验收 · 2026-10-19

本记录对应 [scripts/README](../scripts/README.md) 的群岛运维脚本章节。
历史文档（`fleet-acceptance-2026-10-17.md` 等）按惯例保留当时的名称与路径，
仅作核对史料，不随本次改名。

## 变更内容

宿主机侧运维脚本原以 `mini-ops` 命名空间散装在盘、未入库；Console 代码沿用了
早期 mini-fleet 时代的 `Fleet` 标识符。本次统一到项目命名：

| 旧 | 新 |
| --- | --- |
| `~/.local/libexec/mini-ops/` | `~/.local/libexec/mini-archipel/` |
| `~/.config/mini-ops/` | 并入 `~/.config/mini-archipel/` |
| `~/.local/share/mini-ops/` | 并入 `~/.local/share/mini-archipel/` |
| `~/.local/state/mini-ops/` | `~/.local/state/mini-archipel/` |
| yd-mini-2 `fleet-backups/` | `archipel-backups/` |
| `~/Library/Logs/MiniOps/` | `~/Library/Logs/MiniArchipel/` |
| `local.miniops.vms` / `local.miniops.backup` | `local.miniarchipel.vms` / `local.miniarchipel.backup` |
| `backup-fleet.py` | `backup-archipel.py`（入库） |
| `ci-fleet.json` | `ci-archipel.json` |
| Console `fleet.ts` / `Fleet` / `useFleet` / `fleet-token` / `~/fleet.db` | `archipel.ts` / `Archipel` / `useArchipel` / `archipel-token` / `~/archipel.db` |

宿主机脚本 `host-services.py`、`backup-archipel.py`、节点侧 `export-backup.py`
本次入库 `provisioning/scripts/`；四个宿主机 LaunchAgent 入库
`provisioning/deploy/`。迁移全部用 `mv`，保留权限位与数据；无删除操作。

## 实施与验证

| 检查 | 宿主机 yd-mbp | yd-mini | yd-mini-2 | yd-mbp-tart | yd-mbp-tart-2 |
| --- | --- | --- | --- | --- | --- |
| `~/.local/libexec/mini-archipel/` 就位 | 通过 | 通过 | 通过 | 通过 | 通过 |
| 旧 `mini-ops` 目录清空移除 | 通过 | 通过 | 通过 | 通过 | 通过 |
| `recovery.crt`（及 yd-mini-2 的 `.key`）迁移 | 通过 | 通过 | 通过（含 .key） | 通过 | 通过 |
| 备份历史数据随目录迁移 | 通过 | 通过 | 通过（含 archipel-backups 476MB） | 通过 | 通过 |

仓库侧验证：provisioning unittest 44 项、ruff check/format、shellcheck、
agent `cargo test` 16 项、Console `pnpm check` 全链（lingui check、typecheck、
eslint、biome、prettier、knip、覆盖率 109 项、构建）全部通过。

## 影响与未关闭项

- Console 浏览器端 `fleet-token` / `fleet-theme` 改名后失效：需重新登录一次、
  重选主题，属一次性影响。
- Console 数据库默认值改为 `~/archipel.db`；线上部署一直显式配置
  `console.json` 的 `dbPath` 指向 `~/.local/share/mini-archipel/console.db`，
  `~/fleet.db` 从未存在，无需数据迁移。
- 节点 `~/.local/libexec/` 下遗留的 `mini-fleet-agent.previous*` 等历史回滚
  副本不属本次范围，保留。

## 实测证据（2026-10-19 16:21–16:32）

- 手动执行 `backup-archipel.py`：11.1 秒退出码 0；yd-mini 113085815 B、
  yd-mini-2 1240018 B、yd-mbp-tart 1225874 B、yd-mbp-tart-2 1224962 B、
  host-ops 归档全部 ok；`latest.json` 全绿；新归档
  `20261019-162120-yd-mini.tar.gz.cms` 同时落本机
  `~/.local/share/mini-archipel/backups/yd-mini/` 与 yd-mini-2
  `~/.local/state/mini-archipel/archipel-backups/yd-mini/`，03:30 的历史归档
  完好并存。
- `launchctl list`：`local.miniarchipel.vms`（PID 在运行）、
  `local.miniarchipel.backup`（已加载待 03:30）、两条
  `local.miniarchipel.tunnel.*`（PID 在运行，退出码 0）；`miniops` 标签为零。
- 隧道端到端：`curl http://192.168.9.158:9102/` 与 `:9103/` 均返回 HTTP 404
  （2–3ms，与迁移前一致）。
- Console 0.11.0 重建部署到 yd-mini（旧版留存
  `.previous-20261019-162043`）：`/api/state` 返回 4 主机全部在线、
  数据新鲜度 < 30s、runners / fan-control 插件就绪。
- 两台 tart 虚拟机在 vms 监督器切换期间持续 running（tart list 核对）。
- 残留扫描：宿主机与四节点的 `~/.local/libexec/mini-ops`、
  `~/.local/state/mini-ops`、`~/.config/mini-ops`、`~/Library/Logs/MiniOps`、
  `fleet-backups` 全部不存在。
