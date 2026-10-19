#!/bin/bash
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
[[ $EUID == 0 ]] || { echo 'Run with sudo'; exit 1; }
if launchctl print system/local.miniarchipel.fanctl >/dev/null 2>&1; then
  launchctl bootout system/local.miniarchipel.fanctl
fi
/Library/MiniArchipel/FanControl/fanctl auto
launchctl disable system/local.miniarchipel.fanctl
echo 'Stopped and disabled; Apple automatic fan control restored. Files retained for rollback.'
