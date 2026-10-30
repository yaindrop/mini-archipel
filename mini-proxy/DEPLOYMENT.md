# 四节点发布 · 2026-10-31

运行源码：`d6e3d0d4310db2a5c7cb42c7ca5e760511d76d3b`。
集成提交为 `45fd094`，部署时修复端口 TIME_WAIT 误判的提交为 `d6e3d0d`。
四节点统一使用官方 Xray 26.10.29，资源与仓库锁文件逐文件校验一致。

| 节点 | 工作台稳定 ID | 安装方式 | 当前出口 | 最终状态 |
| --- | --- | --- | --- | --- |
| yd-mini | mini-1 | 升级已有独立服务 | akile-de | ready，允许控制 |
| yd-mini-2 | mini-2 | 升级已有独立服务 | akile-de | ready，允许控制 |
| yd-mbp-tart | yd-mbp-tart | 显式迁移旧 CI 服务 | akile-de | ready，允许控制 |
| yd-mbp-tart-2 | yd-mbp-tart-2 | 显式迁移旧 CI 服务 | akile-de | ready，允许控制 |

所有节点由 `gui/501/com.mini.proxy` 常驻，监听 `127.0.0.1:10808`。
部署前后没有运行中的 CI Worker。安装包内 29 项测试在四节点的系统 Python 上均通过；
安装后的程序与发布源码一致，Xray/geo/LICENSE 校验一致，节点库和运行配置权限为 600。

## Tart 迁移

此次获得明确授权后，两台 Tart 的独立旧服务 `com.flowbit.ci-proxy` 已 disable + bootout，
新服务接管原端口。旧 plist 和 CI 配置保留且摘要不变；未更改 v2rayN GUI、配置或数据库。
原伦敦出口在两台均不可用，因此使用已试跑通过的德国出口。

两台 Agent 的 `mini-proxy.allow_control` 已开启，配置备份为各节点发布目录中的
`agent.toml.before-proxy-control`。Agent 使用原二进制、原签名重启以读取配置；
桌面自动化插件继续 ready，原授权记录保留。没有替换 Console 或 Agent 二进制。
迁移用的临时私有节点库副本已删除。

## 在线验收

通过正式 HTTPS Console → Agent → 新 CLI 链路逐节点检查三个出口，共 12 次：

| 节点 | 德国网络采样 | 新加坡网络采样 | 伦敦 |
| --- | --- | --- | --- |
| yd-mini | 159 ms | 166 ms | 超时，返回失败 |
| yd-mini-2 | 145 ms | 640 ms | 超时，返回失败 |
| yd-mbp-tart | 162 ms | 178 ms | 超时，返回失败 |
| yd-mbp-tart-2 | 152 ms | 175 ms | 超时，返回失败 |

以上取自 CLI 的 `latency_ms`；两次 GET 均返回 204 才算通过。伦敦失败后四节点仍保持
德国出口与 ready 状态。当前线上 Agent 的 `check_ms` 仍为整次 CLI 耗时，未将两种口径混用。
这是本次验收样本，不代表持续延迟保证。

另通过工作台对 `yd-mbp-tart` 执行一次同出口切换，验证配置写入、自己的 launchd 服务重启、
监听归属和健康检查；出口仍保持德国。

## 发布与恢复文件

每台节点的发布包位于：

```text
~/.local/share/mini-archipel/releases/mini-proxy-d6e3d0d/mini-proxy/
```

安装记录为 `~/.local/mini-proxy/deployment.json`，版本资源清单为 `release.json`。
有效安装前备份均位于 `~/.local/share/mini-archipel/mini-proxy-backups/`：

| 节点 | 备份目录名 |
| --- | --- |
| yd-mini | 20261031-000142-8d1cee9b |
| yd-mini-2 | 20261031-000037-c04213a7 |
| yd-mbp-tart | 20261031-000648-e619e993 |
| yd-mbp-tart-2 | 20261031-000736-4aca7bf7 |

实体机可在空闲窗口执行发布包内 `install.py --rollback` 恢复上一独立版本。
Tart 的首次安装回滚只移除新后端，不会自动启用旧 CI 服务；如需回到旧方案，需明确恢复
旧 LaunchAgent。旧方案的伦敦出口目前仍不可用，不能视为健康备用链路。

首台升级曾因 TIME_WAIT 误判两次触发回滚，旧服务均自动恢复；修复后四台安装成功。
未做机器重启测试，也未触发 GitHub CI。代码已本地提交，未推送远端。
不含凭据的本机原始记录保存在 `console/.preview/mini-proxy-deploy-20261030/`，不纳入 Git。
