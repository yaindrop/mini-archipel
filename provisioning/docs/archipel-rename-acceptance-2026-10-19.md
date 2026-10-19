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
| `~/.local/libexec/mini-archipel/` 就位 | 待补 | 待补 | 待补 | 待补 | 待补 |
| 旧 `mini-ops` 目录清空移除 | 待补 | 待补 | 待补 | 待补 | 待补 |
| `recovery.crt`（及 yd-mini-2 的 `.key`）迁移 | 待补 | 待补 | 待补 | 待补 | 待补 |
| 备份历史数据随目录迁移 | 待补 | 待补 | 待补（含 archipel-backups） | 待补 | 待补 |

仓库侧验证：provisioning unittest 44 项、ruff check/format、Console
typecheck / vitest 109 项 / lingui check / 构建与部署探活、agent `cargo test`。
端到端验证：手动执行 `backup-archipel.py` 一轮，四节点导出、sha256 核对、
yd-mini-2 副本与本机落盘全部成功；隧道 9102/9103 端到端仍通；五台机
`mini-ops` / `miniops` / `fleet-backups` 残留为零。实测证据见末节。

## 影响与未关闭项

- Console 浏览器端 `fleet-token` / `fleet-theme` 改名后失效：需重新登录一次、
  重选主题，属一次性影响。
- Console 数据库 `~/fleet.db` 迁移为 `~/archipel.db`，迁移前另存一份副本。
- 节点 `~/.local/libexec/` 下遗留的 `mini-fleet-agent.previous*` 等历史回滚
  副本不属本次范围，保留。

## 实测证据（待补）

- 备份运行记录：待补
- launchctl 状态：待补
- 残留 grep：待补
