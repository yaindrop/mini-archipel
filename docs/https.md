# 工作台 HTTPS

局域网工作台直接由 Console 提供 HTTPS 和 WSS，不增加反向代理。浏览器通过系统信任的本地 CA 校验证书；不使用忽略证书错误、关闭 TLS 校验或浏览器安全开关。

## 身份与私钥

管理 MacBook 使用 `mkcert` 维护专用 CA，`CAROOT` 为
`~/.local/share/mini-archipel/pki/ca`。目录权限 700，CA 私钥仅本人可读，
不得复制到节点、提交 Git 或混入部署包。备份 CA 私钥时应使用独立加密备份。

工作台私钥在 yd-mini 本机生成，只将 CSR 送到 MacBook 签发。
节点接收签出的证书和 CA 公共证书。节点密钥和证书放在版本化目录
`~/.config/mini-archipel/tls/<release>/`，目录 700，私钥 600。
CA 公共证书可分发给需要访问的设备。

当前证书包含 `yd-mini.local`、`yd-mini`、`localhost`、`192.168.9.235`
及 `127.0.0.1`；建议使用稳定的 `yd-mini.local`。IP 改变后需重新签发才能通过新 IP 访问。

## 签发与系统信任

在节点通过 OpenSSL 生成 P-256 私钥与 CSR；CSR 的 subjectAltName 须包含
访问名称和安装健康检查使用的 `127.0.0.1`。在 MacBook 安装 mkcert 后签发：

```sh
CAROOT="$HOME/.local/share/mini-archipel/pki/ca" \
  mkcert -cert-file workbench.pem -csr workbench.csr
```

这台 MacBook 将 CA 加到当前账号的登录钥匙串，只信任 SSL 用途。
只需一次，macOS 会要求系统认证：

```sh
security add-trusted-cert -r trustRoot -p ssl \
  -k "$HOME/Library/Keychains/login.keychain-db" \
  "$HOME/.local/share/mini-archipel/pki/ca/rootCA.pem"
```

若需要让这台 Mac 的所有账号信任，可以选择 mkcert 的系统安装方式
（需要管理员认证）：

```sh
CAROOT="$HOME/.local/share/mini-archipel/pki/ca" TRUST_STORES=system \
  /opt/homebrew/bin/mkcert -install
```

这是安装 CA 公共证书；其他设备应导入并信任同一公共证书，不能复制 CA 私钥。
不要通过点击浏览器的证书警告继续来代替系统信任。

## Console 配置与安装

将叶证书和 `rootCA.pem` 按顺序连接为 `fullchain.pem`，保留节点原私钥。
在节点 `console.json` 中加入 `tls`，证书和密钥必须使用绝对路径：

```json
{
  "tls": {
    "certFile": "/Users/yd-mini/.config/mini-archipel/tls/20261021/fullchain.pem",
    "keyFile": "/Users/yd-mini/.config/mini-archipel/tls/20261021/workbench-key.pem"
  }
}
```

其余配置、令牌及数据库保持原值。部署前私下备份原配置，使用既有
`console/install.sh` 安装构建产物。TLS 材料缺失或密钥不匹配会阻止启动；
安装器通过完整证书链验证 HTTPS 健康检查，不使用 `curl -k`。
TLS 最低版本为 1.2，登录 Cookie 自动加 Secure，前端自动改用 WSS。

启用后同一个 9100 端口只接受 HTTPS，原 `http://` 书签必须改为 `https://`。
重新登录后检查四节点状态与实时连接。运维验收不启停真实 Runner。

## 续期与回滚

使用同一 CA 为新 CSR 签发，放入新的版本目录；校验证书 SAN、有效期、
密钥匹配及证书链后，更新配置并重装 Console。CA 不变时访问设备无需重新信任。
通过 `openssl x509 -in workbench.pem -noout -enddate` 查看到期时间，提前续期。

失败时恢复备份配置，再恢复旧程序和 LaunchAgent；安装器自动恢复程序，
不会自动撤销手动更改的配置。原 HTTP 部署没有 `tls` 字段，回滚时应恢复原配置。
证书与数据库均放在构建产物外，升级不覆盖。

若撤销当前账号对该 CA 的 SSL 信任，在 MacBook 执行：

```sh
security remove-trusted-cert \
  "$HOME/.local/share/mini-archipel/pki/ca/rootCA.pem"
```

若曾通过 mkcert 安装到系统钥匙串，还需撤销相应系统信任：

```sh
CAROOT="$HOME/.local/share/mini-archipel/pki/ca" TRUST_STORES=system \
  /opt/homebrew/bin/mkcert -uninstall
```

官方说明：[mkcert](https://github.com/FiloSottile/mkcert)、
[Apple 证书信任设置](https://support.apple.com/guide/keychain-access/change-the-trust-settings-of-a-certificate-kyca11871/mac)。

## 2026-10-21 实机验收

MacBook 已完成当前账号的 SSL 信任；系统证书校验及不带自定义 CA 参数的 curl 请求通过。
Chromium 和 WebKit 均未忽略证书错误，实际登录、Secure / HttpOnly 会话、WSS、
安全上下文及 `crypto.randomUUID()` 全部正常。四节点快照正常，16 个 Runner 的
Listener / Worker PID 与部署前一致；验收没有启停真实 Runner。

Console 完整质量检查通过，含 114 项单元 / 接口测试；另通过 12 项三浏览器项目的
Runner 与风扇回归、安装器 ShellCheck 和退出等待回归。当前工作台证书到期日为
2029-01-21，后续续签保留同一 CA。
