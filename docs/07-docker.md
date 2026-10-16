# 7. Docker 与 Colima

选 Docker CLI + Colima（VZ 虚拟化），不装 Docker Desktop。

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
