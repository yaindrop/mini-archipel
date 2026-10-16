#!/bin/bash
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
[[ $EUID == 0 ]] || { echo 'Run with sudo'; exit 1; }
if launchctl print system/com.macmini.fan-control >/dev/null 2>&1; then
  launchctl bootout system/com.macmini.fan-control
fi
/Library/MacMiniFanControl/fanctl auto
launchctl disable system/com.macmini.fan-control
echo 'Stopped and disabled; Apple automatic fan control restored. Files retained for rollback.'
