# 桌面自动化插件

Mini Archipel通过既有后台任务调用固定伴随App。系统英文名为 **Mini Archipel Plugin: Automation**，中文名为 **群岛插件：自动化**；按macOS语言显示。可移植路径为 `~/Applications/Mini Archipel Plugin - Automation.app`，原Bundle ID `local.yaindrop.agent-script-runner`、`~/agent-script-runner` 技术入口与任务数据保留兼容。

## 安装、升级与回退

从准确源码构建或使用已验签的伴随App：

```sh
SIGN_IDENTITY=已有证书指纹 SIGN_KEYCHAIN=/path/scoped.keychain-db \
  python3 plugins/automation/runtime/build.py --output '/path/new/Mini Archipel Plugin - Automation.app'
python3 plugins/automation/install.py --companion '/path/new/Mini Archipel Plugin - Automation.app'
```

构建不会启动App或申请权限。持续签名复用已有证书，密码按其既有安全流程通过stdin解锁，不能写入命令行、仓库或日志；不要每次建证书。App与节点Agent各保自己的Bundle ID/签名身份，首次从临时签名切换须实测正常系统授权，不宣称自动继承。

安装器先检查后台任务及运行中的伴随App，忙时拒绝；对旧 `~/Agent Script Runner.app` 做完整备份后迁至新路径，保原CLI名。已安装正确新App时，普通工具包升级保持App字节；明确 `--upgrade-app` 或提供 `--companion` 才替换。旧App/CLI及工具包保留回退，新签名安装会保留旧权限缓存证据并使当前缓存失效，等待真实复验。

```sh
python3 plugins/automation/install.py --rollback
```

回退同时恢复对应工具包、App和CLI；失败恢复原安装，不改TCC或其他App。系统权限不是程序备份的一部分，回退后仍需真实检查。单次安装也可不传 `--companion` 在本地编译，但部署时应优先使用已固定签名和SHA的预构建App。

## 权限与工作台

控制台「桌面自动化」逐项显示目标节点、辅助功能、Apple Events / System Events、最近检查时间，以及未检查/待授权/等待本人确认/已验证可用。每项有「重新检查」「请求授权」。普通状态轮询只读任务及已检测数据，不调用系统请求；后台任务执行显式请求并在有界等待内自动复验，关闭插件不会取消已接受任务。

- 辅助功能：静默检查 `AXIsProcessTrusted` 并验证真实AX查询；显式请求才使用系统提示并定位辅助功能设置。
- Apple Events：静默检查实际的System Events进程枚举事件授权，再验证真实调用；读取应用版本是免授权操作，不能当成功证明。显式请求仅针对所选权限，实际发送需要授权的进程枚举事件并定位自动化设置。
- 只在真实能力复验成功后显示已验证可用；旧缓存/开关为1不能代替验证。无法自动批准时，由操作者在节点准确App项完成最后原生确认，工具不保存密码、不使用全局权限重置或TCC数据库操作。

CLI保持可用：

```sh
~/.local/libexec/mini-archipel-desktop/desktop-automation status
~/agent-script-runner authorize --permission accessibility
~/agent-script-runner authorize --permission automation
~/agent-script-runner exec /usr/bin/true
```

GUI/API沿用现有鉴权、插件开关和 `allow_control`；任意脚本还需 `allow_scripts`。节点后台API `submit` 使用稳定 `request_id`，同ID同内容复用，不同内容冲突；授权请求为 `{"request_id":"permissions-1","operation":"permissions","permission":"accessibility","timeout":180}`（自动化权限改为 `automation`），检查为 `operation:"doctor"`。通过 `get` 查看原请求，不用新ID盲重试。取消等待不能撤回已经发生的应用操作。

## 验证

```sh
python3 -m unittest discover -s plugins/automation/runtime -p 'test_*.py'
```

单测不申请权限、不操作真实聊天。真实验收还须核中英文Finder/系统权限页、正常安装与回退、逐项显式请求/静默检查/实际能力复验，以及经新App执行无害脚本。任何聊天发送测试都需独立明确授权，不以权限测试替代。
