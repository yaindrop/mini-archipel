# 4. 更新与安全基线

两台机器历史配置曾不一致；**新机统一采用以下基线**（自动下载、手动安装
系统更新；安全更新自动；防火墙开启）：

```sh
sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticDownload -bool true
sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates -bool false
sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate ConfigDataInstall -bool true
sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate CriticalUpdateInstall -bool true
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate on
```

开启防火墙后核对 SSH 与屏幕共享仍可达。FileVault 与 SIP 保持开启。
