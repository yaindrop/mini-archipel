# 5. 代理与网络（双入口）

CI 机通常需要稳定的出境代理。方案是**两个独立入口**，互不依赖：

四台统一安装官方 macOS ARM64 v2rayN，应用位置为 `~/Applications/v2rayN.app`。
当前配置包含 `akko-lon`、`akile-de`、`akile-lax` 三个节点，默认 `akko-lon`。
此处仅记录节点名称；地址、UUID 与 Reality 参数从私有配置导入，不进仓库。

| 用途                | 实现                              | 监听              | 启动                                                                   |
| ------------------- | --------------------------------- | ----------------- | ---------------------------------------------------------------------- |
| CI、shell、容器拉取 | 独立 Xray 进程（v2rayN 随包内核） | `127.0.0.1:10808` | 用户 LaunchAgent（RunAtLoad/KeepAlive），标识 `com.flowbit.ci-proxy` |
| 桌面应用/系统代理   | v2rayN GUI 自管内核               | `127.0.0.1:10809` | 按需开 GUI                                                             |

要点：

- 两个端口只监听本机；不开局域网代理，不用 TUN。
- GUI 锁屏后重启会报渲染错误，所以 CI 走独立 Xray。
- GUI 按需启动；退出 GUI 后 CI 入口仍应可用。客体不能把宿主机临时 SSH
  转发当作常驻代理，否则宿主机关闭终端就会断 CI。
- 控制机和节点的系统代理应绕过本地名称及管理网段（当前为 `*.local`、
  `*.lan`、`192.168.9.0/24`、`192.168.64.0/24`）；shell 的 `no_proxy`
  不会替系统应用设置绕过名单。
- 含节点凭据的配置文件权限 600，备份目录 700；凭据不进文档。
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
curl --proxy http://127.0.0.1:10808 --noproxy '' -I https://api.github.com/
```

## 节点管理

- 节点切换：先在临时端口验证新节点，再替换运行配置并重载，失败恢复。
- 只在 GUI 里选节点**不会**改变独立 CI 配置——两处分别更新、分别验证。
- 常规切换等 runner 空闲；写一个小助手从节点数据库读取并切换，避免在
  命令行重复书写凭据。
- 验收逐个节点连通性、GUI 节点列表与两个端口；不能只验证默认节点或安装包存在。
