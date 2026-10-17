# 7. Docker 与 Colima

实体机选 Docker CLI + Colima（VZ 虚拟化），不装 Docker Desktop。

**Tart macOS 客体不要求运行本机容器引擎。** 当前 Tart 的嵌套虚拟化只支持
Linux 客体；不能通过给 macOS 客体加 `--nested` 来启动 Colima VZ。
2026-10-17 两台客体实测均返回 `Virtualization is not available on this hardware`。
Docker / Compose / Buildx CLI 可保留，但安装成功不等于容器可运行。

需要容器的作业通过通用 `container` 能力标签调度到已验收的实体机；Flowbit 专项保留 `flowbit-container` 标签；不要只依赖四台
共有的 `ci`。没有容器需求的 macOS 作业仍可在
Tart 运行。若以后确实需要远程 Docker，引入独立、认证的引擎并单独验收，
不要默认把宿主机 Docker socket 暴露给客体。

参考：[Tart：嵌套虚拟化限制](https://tart.run/faq/#nested-virtualization-support)。

```sh
# 首次创建（资源按需调整；--disk 是稀疏上限，实际占用按需增长）
colima start --vm-type vz --cpus 2 --memory 4 --disk 30
docker run --rm hello-world
docker compose version && docker buildx version
colima stop
```

- CLI 插件目录写入 `~/.docker/config.json`（合并，勿整文件覆盖）：

```json
{ "cliPluginsExtraDirs": ["/opt/homebrew/lib/docker/cli-plugins"] }
```

- **按需启动**，用完 `colima stop`；不做 `brew services start colima` 常驻。
- Colima 客体内 `/etc/resolv.conf` 失效时：按机器网络设置客体 DNS 与宿主
  代理地址。
- 验收：Registry 返回预期 401、能拉镜像、容器 `uname -m` 为 `aarch64`。
