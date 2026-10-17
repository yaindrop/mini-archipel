# 1. 账户与远程访问

人在新机前完成：首次开机、创建账户（确定短用户名与个人目录，如 `mini-1`）、
连接 Wi-Fi、进入桌面。之后除身份验证外都可远程完成。

## 开启远程能力

在目标机的系统设置 → 通用 → 共享 → 高级中，**以下三项必须同时开启**。
分别进入每项的详情，将访问范围设为指定运维账户（如 `mini-1`）：

- **远程管理**：提供桌面查看与操作；为运维账户授予“观察”和“控制”权限。
- **远程登录**：提供 SSH 访问（22 端口），允许运维账户登录。
- **远程应用程序脚本**：允许控制机发送远程 Apple 事件、执行 AppleScript；
  在“仅这些用户”中加入运维账户。

桌面访问由“远程管理”提供。控制机仍可使用“屏幕共享”App 或 `vnc://`
连接（5900 端口），无需另行开启目标机的“屏幕共享”开关。

**远程管理开关打开后，还必须配置账户权限**。若账户缺少观察/控制权限，
可在目标机以该运维账户登录 SSH 后补齐：

```sh
sudo /System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart \
  -configure -users "$(id -un)" -access -on -privs -ControlObserve
```

这条命令只补齐当前账户权限；首次开启服务及系统要求的授权仍在目标机的
系统设置中完成。不能仅凭命令返回 `Done` 判断远程访问已可用。

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

## 实际验证

从控制机逐项验证，三项均通过才算完成：

1. **远程登录**：公钥 SSH 实际登录成功。

```sh
ssh -o BatchMode=yes -o ConnectTimeout=8 mini-1
```

核对认证方式时加 `-o PreferredAuthentications=publickey`，避免把模板镜像的
空密码/`none` 认证误算作公钥成功。Tart 导入后生成独立 SSH 主机密钥与
控制机访问密钥，验证公钥可用后设置 `PermitEmptyPasswords no`，并用
`sshd -t` / `sshd -T` 核对。既有有效公钥与其他管理员访问不能误删。

2. **远程管理**：运行 `open 'vnc://mini-1.local'`，使用已授权的运维账户
   登录，确认桌面可见且鼠标、键盘可操作。
3. **远程应用程序脚本**：从控制机使用“脚本编辑器”向目标机发送一条只读
   远程 AppleScript（如读取应用版本），确认账户认证成功并返回结果。

## 经验

- 远程管理已开启但账户未授权时，输入正确密码也可能被拒绝；先检查该账户
  的观察/控制权限。此前实测服务端出现 `not valid admin`、
  `Authentication: FAILED`，补齐权限后认证成功。
- 局域网可用 `.local`（Bonjour）或路由器 `.lan` 名称；新机以实际解析结果
  配置别名，不照抄旧机 IP。
- 屏幕共享连接时系统会语音播报"电脑正被远程控制"；系统无独立关闭开关。

参考：[Apple：启用远程桌面的远程管理](https://support.apple.com/zh-cn/guide/remote-desktop/apd8b1c65bd/mac)、
[Apple：允许远程应用程序脚本](https://support.apple.com/en-ie/guide/mac-help/mchlp1398/27/mac/27)。
