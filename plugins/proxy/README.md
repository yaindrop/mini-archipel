# Mini Proxy 后端

Mini Archipel 的独立代理后端。Console 的 `proxy` 插件通过节点 Agent 调用
`mini-proxy-select`，CLI 负责试跑、测速、切换和恢复；用户级 LaunchAgent 负责常驻
Xray。关闭插件不会停止代理。代码、安装器和版本清单由本仓库维护，节点凭据留在节点。

支持 macOS Apple Silicon、Python 3.9+、已登录的普通用户；不需要 root 或额外 Python 包。
目前支持 VLESS RAW/TCP + Reality。保留现有 Agent 的命令、路径和 `latency_ms N` 输出协议。

## 安装与升级

先在仓库根目录准备依赖：

```sh
python3 plugins/proxy/fetch.py
# 无网络时，使用同版本官方发布包，仍校验所有 SHA-256：
python3 plugins/proxy/fetch.py --archive /path/to/Xray-macos-arm64-v8a.zip
```

固定版本和校验值在 [assets.lock.json](assets.lock.json)。当前使用官方 Xray 26.10.29
的 macOS ARM64 包，下载源为 [XTLS/Xray-core 发布页](https://github.com/XTLS/Xray-core/releases/tag/v26.10.29)。
同时校验压缩包、Xray、两份 geo 数据和 LICENSE，只提取清单中的文件。
缓存位于 `.cache/assets/`，不进 Git；随安装保留上游 LICENSE。升级上游版本必须更新
完整清单并重新验证，安装器不会自动追踪最新版。

首次安装：按 [nodes.example.json](nodes.example.json) 在仓库外创建真实节点文件，
将占位符替换为自己的参数，权限设为 `600`。`password` 是 VLESS UUID，`publicKey`
是 Reality 公钥；可选 `flow` 默认为 `xtls-rprx-vision`。

```sh
chmod 600 /path/to/private-nodes.json
python3 plugins/proxy/install.py --nodes /path/to/private-nodes.json --node example-exit
```

在目标节点运行安装器；可将整个 `plugins/proxy/` 目录连同 `.cache/assets/` 一起复制过去，
或通过 `--assets /path/to/verified-assets` 指定离线资源。不要用 root 运行。

已有独立后端的升级与回滚（沿用已安装的服务标签）：

```sh
python3 plugins/proxy/install.py
python3 plugins/proxy/install.py --rollback
```

升级保留原节点库、当前出口、路由和监听配置，只替换 `proxy` 出站及受管理的程序文件。
传入 `--nodes` 可更新节点库，传入 `--node` 可指定出口。每次升级先校验资源和配置，
再在临时端口实际试跑，最后备份并替换。启动或健康检查失败会恢复旧文件和服务。
`--rollback` 恢复上次安装前的状态，包括原先是否加载服务；首次安装回滚会移除受管理文件。
备份含凭据，目录权限 `700`，文件 `600`，保存在
`~/.local/share/mini-archipel/mini-proxy-backups/`，按自己的保留策略清理旧备份。

安装器管理 `local.miniarchipel.proxy`，兼容已有 `com.mini.proxy` 安装，两个 plist 并存时拒绝操作。
首次安装要求 10808 空闲；端口被其他代理占用时直接拒绝，
不自动迁移。旧的 `com.flowbit.ci-proxy` 不属于该安装器；开启工作台插件也不会把它
转换成 Mini Proxy 后端。工具不操作 v2ray/v2rayN，不修改系统代理、shell 环境或 Agent 配置。

## 单独迁移服务标签

`migrate-service.py` 将 `com.mini.proxy` 迁至 `local.miniarchipel.proxy`，保留 plist 的其他字段，
并更新 CLI 后端以识别两种标签。Xray、geo 资源、节点库、配置和命令入口按字节及权限校验。
先按节点约定停接并等待已有 CI 自然结束，将空闲 Listener 暂停，保留原暂停/停用状态。
脚本在操作期间持有 CI 钩子与 Agent 共用的 `~/.local/state/mini-archipel/ci/mutex`，
并持有代理操作锁，防止接单策略恢复 Listener 或并发切换出口。

```sh
python3 plugins/proxy/migrate-service.py
python3 plugins/proxy/migrate-service.py --rollback
```

迁移前保存原 plist、管理代码、加载和禁用状态到权限 `600` 的
`~/.local/mini-proxy/service-label-migration.json`。异常会自动恢复，进程被强制中断后可用
`--rollback` 恢复，重试迁移也先恢复未完成事务。原服务未加载时，迁移及回滚均保持未加载。
禁用状态先采用 `launchctl print-disabled` 的显式覆盖，缺省时采用 plist 的 `Disabled`
（未设置时取 false）。恢复记录保存两个标签的有效状态，回滚用显式 enable/disable 恢复。
原新标签没有 plist 和覆盖项时，其有效值为 false，回滚写入显式 enable；原已有的 true/false
覆盖按原值恢复。launchctl 未提供逐标签清除覆盖项的公开命令，因此缺省项会归一为显式值。
迁移后文件有外部改动时拒绝覆盖，需先检查记录和新改动。迁移完成后恢复原接单状态。
正常安装的旧备份需先回滚标签再恢复，避免把旧标签 plist 写到新标签路径。

Agent 权限检查兼容两种标签。Agent 二进制按持续签名身份单独部署及回退，标签回滚只恢复
代理管理代码和服务，不覆盖 Agent。双标签兼容 Agent 可以保留到任一标签状态。

## 节点文件与服务

| 路径                                          | 内容                                           |
| --------------------------------------------- | ---------------------------------------------- |
| `~/.local/mini-proxy/bin/`                    | 固定版本 Xray、geoip.dat、geosite.dat、LICENSE |
| `~/.local/mini-proxy/backend.py`              | CLI 实现                                       |
| `~/.local/mini-proxy/nodes.json`              | 私有节点库，权限 600                           |
| `~/.config/mini-proxy/config.json`            | 运行配置，权限 600                             |
| `~/.config/mini-proxy/config.json.previous`   | 上一次切换前的配置，权限 600                   |
| `~/.local/bin/mini-proxy-select`              | Agent 和人工共用的命令入口                     |
| `~/Library/LaunchAgents/local.miniarchipel.proxy.plist` | 用户登录后常驻服务，兼容旧标签路径 |
| `~/Library/Logs/MiniProxy/xray.log`           | Xray 日志                                      |
| `~/.local/mini-proxy/release.json`            | 已安装的资源版本与校验值                       |

全新配置只监听 `127.0.0.1:10808`，同时支持 HTTP/SOCKS；私网和国内地址直连，
Google 规则优先走代理，其余默认走代理。升级保留既有路由，不替旧配置补写分流规则。
受管理路径中的无关文件会保留，安装器不会遍历或复制整个用户目录。

## 操作与测量

```sh
~/.local/bin/mini-proxy-select --check example-exit
~/.local/bin/mini-proxy-select example-exit
```

`--check` 在随机回环端口启动独立 Xray，测试流量全部走候选出口。同一条 HTTPS 连接向
`https://www.google.com/generate_204` 发出两次 GET，间隔 100 毫秒，要求均返回 204，
取较小耗时（毫秒）。首轮包含建立隧道和 TLS，第二轮复用连接；这是请求延迟，不是整条
安装/切换链路耗时。测试进程退出时回收，服务和运行配置不变。

切换先做同样的候选测试，通过后原子写入配置，重启自己的服务，再验证监听进程归属及
实际连通性。失败或可捕获的中断会恢复旧配置并复验；错误会明确说明恢复是否成功。
CLI 成功输出 `latency_ms N`，供 Agent 读取网络采样值，失败返回非零且不输出节点凭据。
较旧 Agent 的 `check_ms` 可能仍表示整次 CLI 耗时，部署时应区分两种口径。

安装、升级、回滚、检查和切换共用节点级文件锁，冲突立即返回。任何仓库存在
`Runner.Worker` 时禁止安装和切换，候选试跑后再次检查，`--check` 可以在 CI 作业期间使用。
这是操作时检查，不会暂停 Runner 接单；维护时仍需选择空闲窗口。SIGKILL、断电无法运行
恢复代码，需根据备份和 `config.json.previous` 手动恢复。请求有超时，不会无限等待。

工作台插件需在 Console 和目标 Agent 启用；切换还需 `allow_control = true`。
只启用插件而未安装后端时会显示 `not_installed`。服务由 launchd 独立管理。
网络接入配置与 Agent 插件约定见 [代理装机文档](../../provisioning/docs/05-proxy.md)。

## 验证

从仓库根目录运行（测试不会操作真实代理或 LaunchAgent）：

```sh
python3 -m unittest discover -s plugins/proxy/tests -v
/usr/bin/python3 -m unittest discover -s plugins/proxy/tests -v
provisioning/.venv/bin/ruff check plugins/proxy
provisioning/.venv/bin/ruff format --check plugins/proxy
```

覆盖资源完整性、凭据校验、两次 HTTP 204、并发互斥、CI 保护、候选失败、异常恢复、
安装升级/回滚、外部服务与端口冲突、保留无关文件。共享 CI 的 provisioning 阶段运行该套测试。
真实网络验收使用 `--check` 逐个检查节点；安装及 launchd 重启验收需在目标机器维护窗口执行。
本次检查结果与尚未验证的范围见 [验收记录](VALIDATION.md)。
已完成的四节点安装、Tart 迁移和在线验收见 [部署记录](DEPLOYMENT.md)。

## 节点权限与复验

`agent/` 与 `console/` 分别是原生节点和工作台实现，安装器与 Xray 锁定资源同目录维护。
工作台按节点静默检查安装文件及新旧代理用户服务，显示时间、原因与安装入口。
当前实现无需额外系统授权：没有 TUN、系统代理或 TCC 请求；`allow_control` 是配置开关。
“查看授权说明”不会弹出系统授权或改变服务，安装后用“重新检查”复验。
此权限检查不会读取或改动 v2ray/v2rayN 客户端。
