# 4. 更新与安全基线

四台机器统一采用以下更新策略（自动下载、手动安装
系统更新；安全更新自动）：

```sh
sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticDownload -bool true
sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates -bool false
sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate ConfigDataInstall -bool true
sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate CriticalUpdateInstall -bool true
```

实体机开启防火墙，受信任宿主机上的私有 NAT 客体不要求额外开启：

```sh
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate on
```

实体机按[第 1 章](01-accounts-and-remote-access.md#实际验证)复核：
SSH 可登录、远程管理可查看并控制桌面、远程应用程序脚本可认证并返回结果。
实体机 FileVault 与 SIP 保持开启。

## Tart：安全主要由宿主机提供

适用于本机私有、受信任的 CI 客体。**客体豁免 FileVault**，允许自动登录和
运维账户免密 sudo；不照搬实体机的磁盘解锁、物理接触、锁屏恢复等验收项。
不为客体增加没有实际收益的安全代理、重复加密或复杂登录流程。

前提是宿主机 FileVault 开启、账户访问受控，Tart 镜像和备份受同等保护，
客体使用 NAT 网络。需要转发的运维端口只开放到预期管理网络，不直接暴露
到公网。镜像迁移到共享宿主机、对外提供服务或运行不受信任代码时，重新评估
这些豁免；宿主机加密不能隔离正在运行的恶意客体或作业。

仍保留几项直接关系到运维和凭据安全的要求：

- SSH / 远程管理 / 远程 Apple 事件使用指定账户认证。SSH 必须实际用公钥
  登录，禁用空密码认证；自动登录与免密 sudo 不等于允许匿名网络登录。
- runner 独立注册，凭据不跨机复制；代理与 runner 配置权限 600。
- 代理仅监听回环地址，不向客体转发宿主机 SSH agent、登录凭据或整个个人目录。
- SIP 保持系统默认保护开启。私有 NAT 客体允许防火墙关闭；宿主机必须限制入站网络与转发端口，不额外部署安全代理。

“豁免非必要加固”不等于关闭所有保护。是否采用额外措施按实际用途判断，
不能为了与实体机看起来一致而增加故障点。

### 监控服务防火墙注册

物理机启用系统防火墙时，群岛 Agent 的当前程序路径 `~/.local/libexec/mini-archipel-agent` 必须登记为允许入站。项目迁移或程序路径变化后，使用随 Agent 安装的 `mini-archipel-firewall.sh` 更新应用规则；先添加新路径，再删除旧路径，不关闭防火墙。执行后从另一台机器验证 Agent 的 `/health`，仅本机健康检查不足以证明跨机可达。虚拟机按既有安全分类由宿主机和虚拟网络保障，不为此额外启用虚拟机防火墙。

```sh
sudo bash ~/.local/libexec/mini-archipel-firewall.sh "$(id -un)"
```
