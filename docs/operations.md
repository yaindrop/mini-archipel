# 日常运维命令

在对应 mini 的 SSH 会话执行。停止/重启服务前先确认无正在运行的任务。

```sh
# 服务与代理
pgrep -fl 'Runner.Listener|Runner.Worker'
launchctl print "gui/$(id -u)/com.example.ci-proxy"
curl --proxy http://127.0.0.1:10808 --noproxy '' -I https://api.github.com/

# runner 实际工具环境
cd "$HOME/github-runners/<repo>" && export PATH="$(cat .path)"
node --version; pnpm --version; python3 --version; uv --version; rustc --version

# 工作区工具链与空间
cd "$HOME/github-runners/<repo>/_work/<repo>/<repo>"
bash scripts/ci-toolchain.sh      # 目标项目自带的核对脚本
df -h /System/Volumes/Data
du -sh "$HOME/github-runners/<repo>/_work"
sysctl vm.swapusage
mdutil -a -s

# 风扇控制
/Library/MacMiniFanControl/fanctl -j status
launchctl print system/com.macmini.fan-control | grep pid
tail -n 20 /Library/Logs/MacMiniFanControl/control.log

# 热状态（0 nominal / 1 fair / 2 serious / 3 critical）
osascript -l JavaScript -e 'ObjC.import("Foundation"); $.NSProcessInfo.processInfo.thermalState;'
```

runner 接单状态（在有仓库权限的控制机）：

```sh
gh api repos/<owner>/<repo>/actions/runners --jq '.runners[] | {id, name, status, busy}'
```
