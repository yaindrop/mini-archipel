# 1. 账户与远程访问

人在新机前完成：首次开机、创建账户（确定短用户名与个人目录，如 `mini-1`）、
连接 Wi-Fi、进入桌面。之后除身份验证外都可远程完成。

## 开启远程能力

系统设置 → 通用 → 共享：

- 开启**远程登录**（SSH，22 端口），允许指定账户。
- 开启**屏幕共享**（VNC，5900 端口），作为 GUI 备用通道。

## 控制机侧配置

1. 为每台 mini 生成独立 Ed25519 密钥；只把公钥加入对应机器的
   `~/.ssh/authorized_keys`。
2. mini 侧权限：`~/.ssh` 700，`authorized_keys` 600。
3. 控制机 `~/.ssh/config`：

```sshconfig
Host mini-1
    HostName mini-1.local
    User mini-1
    IdentityFile ~/.ssh/mini-1
    IdentitiesOnly yes
    ConnectTimeout 8
```

4. 实际验证：公钥 SSH 登录、屏幕共享画面可操作（`open 'vnc://mini-1.local'`）。

```sh
ssh -o BatchMode=yes -o ConnectTimeout=8 mini-1
```

## 经验

- 局域网可用 `.local`（Bonjour）或路由器 `.lan` 名称；新机以实际解析结果
  配置别名，不照抄旧机 IP。
- 屏幕共享连接时系统会语音播报"电脑正被远程控制"；系统无独立关闭开关。
