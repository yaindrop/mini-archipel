# Agent 的持续签名身份

macOS 完全磁盘访问授权会校验程序的 designated requirement。临时签名的要求绑定单一版本的代码哈希；升级后二进制内容变化会使旧授权失配。

本地部署使用独立的代码签名证书，保持 `local.miniarchipel.agent` 标识和同一证书。此证书不加入系统信任根，不授予隐私权限，不把检查降级为仅匹配名称。证书私钥和专用 keychain 位于用户目录中，绝不进入仓库。

```sh
python3 agent/setup-local-signing.py
# 从专用 keychain 的 identity 列表取得指纹。自行创建的本地证书不会出现在“受信任的有效 identity”列表中。
security find-identity -p codesigning ~/Library/Keychains/mini-archipel-signing.keychain-db
ARCHIPEL_SIGN_IDENTITY=<指纹> \
ARCHIPEL_SIGN_KEYCHAIN=~/Library/Keychains/mini-archipel-signing.keychain-db \
  agent/sign-local.sh
```

脚本通过 stdin 传递 keychain 密码，不把密码写进进程参数或输出。首次准备使用 OpenSSL；签名本身使用 macOS codesign。私钥允许 codesign 使用，导入时设为不可导出；初始化材料保存在 `~/.local/share/mini-archipel/signing/`，目录 0700、私钥及密码文件 0600。应离线加密备份此目录和专用 keychain；丢失身份后需重新签名并重新授权。不要每次构建都创建证书。

从旧临时签名切换时，仍需在每台节点的系统设置中移除旧 Agent 条目，重新添加最终已签名文件并开启完全磁盘访问。以后用同一身份升级，并在分发前核对 designated requirement 和签名。公开分发应使用 Apple 的 Developer ID 与适用的分发流程；此本地证书仅用于自有节点。

依据：Apple [代码签名要求](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)、[代码签名指南](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/Procedures/Procedures.html)。
