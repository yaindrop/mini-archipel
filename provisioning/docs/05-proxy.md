# 5. 代理与网络（mini-proxy 单入口）

CI 机需要稳定的出境代理。方案是 **mini-proxy**：一个无界面、由 launchd 常驻的
Xray 实例，是本机**唯一**代理来源——CI、shell 与系统代理都指向同一入口。
v2rayN GUI 双入口方案已废弃：GUI 的生命周期与节点选择由人控制，无法满足 CI
的 7×24 要求；mini-proxy 的二进制、geo 资源与节点库全部自持，不依赖 GUI 应用。

节点名称当前为 `akile-sg`、`akile-de`、`akko-lon`；地址、UUID 与 Reality 参数
存放在节点的 `~/.local/mini-proxy/nodes.json`（权限 600），不进仓库。

后端源码、固定版本依赖和安装器已纳入本仓库的 [mini-proxy 模块](../../mini-proxy/README.md)。
先运行 `python3 mini-proxy/fetch.py` 准备资源，再在目标节点执行
`python3 mini-proxy/install.py --nodes /path/to/private-nodes.json --node <出口名>`。
已有独立安装升级只需 `python3 mini-proxy/install.py`，失败自动恢复，可用 `--rollback`
恢复上次安装前状态。安装器不修改系统代理或 shell；10808 被其他服务占用时拒绝安装，
不会自动接管 Tart 上既有的 `com.flowbit.ci-proxy`。

| 用途                 | 实现                                    | 监听                              | 启动                                                        |
| -------------------- | --------------------------------------- | --------------------------------- | ----------------------------------------------------------- |
| CI、shell、系统代理  | mini-proxy（`~/.local/mini-proxy/bin`） | `127.0.0.1:10808`（HTTP+SOCKS）   | 用户 LaunchAgent `com.mini.proxy`（RunAtLoad/KeepAlive）    |

目录布局（全部用户态，无 root）：

| 路径                              | 内容                                |
| --------------------------------- | ----------------------------------- |
| `~/.local/mini-proxy/bin/`        | xray 二进制与 geo 资源              |
| `~/.local/mini-proxy/nodes.json`  | 节点凭据（600）                     |
| `~/.config/mini-proxy/config.json`| 运行配置（600，含国内直连路由）     |
| `~/.local/bin/mini-proxy-select`  | 切换 / 检查 CLI                     |

要点：

- 只监听本机；不开局域网代理，不用 TUN。客体不能把宿主机临时 SSH 转发当作
  常驻代理，否则宿主机关闭终端就会断 CI。
- 新装默认路由：`geoip:private`、`geosite:cn`、`geoip:cn` 直连，Google 优先走代理，
  其余走出口节点。升级和切换保留原路由，不自动补写旧配置。
- 系统代理（HTTP/HTTPS/SOCKS）与 shell 环境变量全部指向 10808；系统代理绕过
  本地名称及管理网段（当前为 `*.local`、`*.lan`、`192.168.9.0/24`、
  `192.168.64.0/24`）；shell 的 `no_proxy` 不会替系统应用设置绕过名单。
- 含节点凭据的文件权限 600，备份目录 700；凭据不进文档。
- shell/CI 显式导出：

```sh
export http_proxy=http://127.0.0.1:10808 https_proxy=http://127.0.0.1:10808
export HTTP_PROXY="$http_proxy" HTTPS_PROXY="$https_proxy"
export all_proxy=socks5://127.0.0.1:10808 ALL_PROXY="$all_proxy"
# no_proxy 排除 localhost 与自己的网段
export no_proxy=localhost,127.0.0.1,::1,192.168.<subnet>/24
export NO_PROXY="$no_proxy"
```

验证：

```sh
curl --proxy http://127.0.0.1:10808 --noproxy '' -o /dev/null -w '%{http_code} %{time_total}\n' --max-time 10 https://www.google.com/generate_204
# 国内直连应显著快于境外站点
curl --proxy http://127.0.0.1:10808 --noproxy '' -sS -o /dev/null -w '%{time_total}\n' https://www.baidu.com
```

## 节点管理

- `mini-proxy-select <node>`：先在随机回环端口做真连接延迟测试。测试流量只走该节点，不套用日常的直连规则。同一条连接请求 `https://www.google.com/generate_204` 两次，间隔 100 毫秒，两次均须返回 204，取较快的一次。通过后再原子替换配置并重启自己的服务，新节点不通自动回滚。
- `mini-proxy-select --check <node>`：只测不切。
- 日常路由在 `geoip:cn` 之前把 `geosite:google` 送进代理。否则 `IPIfNonMatch` 可能按解析地址把 Google 判成直连，探测会超时。
- 任意仓库的 runner 有作业运行时禁止安装和切换，候选试跑后再次检查；所有操作共用文件锁。
- 加节点：编辑 `nodes.json` 追加同名条目（address、password、sni、publicKey、
  shortId 等），CLI 自动识别。vless 分享链接参数映射：`type=tcp` → `"network":
  "raw"`、`pbk` → `publicKey`、`sid` → `shortId`、`spx` → `spiderX`。
- 升级 xray：更新仓库的 `assets.lock.json` 并校验资源，使用安装器升级；
  保留旧版程序、节点库、配置和服务状态备份，不再直接覆盖运行中的二进制。
- 验收逐个节点 `--check`、系统代理指向、shell 导出与 10808 连通性；不能只验证
  默认节点或安装包存在。

## mini-archipel 插件

agent 内置 `mini-proxy` 插件（默认停用，装机后在 agent 配置启用）：

- 上报：可用性（ready / degraded / service_down / not_installed）、当前出口、
  节点列表、出口探测延迟与各节点最近一次检查结果；凭据永不上报。
- 操作：`check`（测速检查）始终可用；`switch`（切换出口）需在 agent 插件
  配置开启 `allow_control`，并继承 CLI 的试跑验证、失败回滚与 CI 忙时保护。
- 工作台“代理出口”页提供节点表、测速与确认后切换。
