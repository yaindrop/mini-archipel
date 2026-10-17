# 日常运维命令

在对应节点的 SSH 会话执行。停止/重启服务前先确认无正在运行的任务。
示例中的 `<repo>` 替换为实际仓库名，当前为 `flowbit`；风扇命令仅用于实体机。

```sh
# 服务与代理
pgrep -fl 'Runner.Listener|Runner.Worker'
launchctl print "gui/$(id -u)/com.flowbit.ci-proxy"
curl --proxy http://127.0.0.1:10808 --noproxy '' -I https://api.github.com/

# runner 实际工具环境
cd "$HOME/runners/<repo>" && export PATH="$(cat .path)"
node --version; pnpm --version; python3 --version; uv --version; rustc --version

# 工作区工具链与空间
cd "$HOME/runners/<repo>/_work/<repo>/<repo>"
bash testing/scripts/ci-toolchain.sh      # Flowbit 的核对脚本
df -h /System/Volumes/Data
du -sh "$HOME/runners/<repo>/_work"
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
