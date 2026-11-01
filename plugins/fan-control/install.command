#!/bin/bash
# Explicit user entry: build without privileges, then ask through macOS authorization.
set -euo pipefail
cd "$(dirname "$0")"
./build.sh
/usr/bin/osascript - "$PWD/install-plugin.sh" "$(id -un)" <<'APPLESCRIPT'
on run arguments
    set installer to item 1 of arguments
    set agentAccount to item 2 of arguments
    do shell script (quoted form of installer & " " & quoted form of agentAccount) with administrator privileges
end run
APPLESCRIPT
printf '\n%s\n' '安装完成。请返回工作台，重新检查节点能力。'
