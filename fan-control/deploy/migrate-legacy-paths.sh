#!/bin/bash
# One-time convergence of pre-archipel fan-control paths on a Mac mini.
# Run with sudo from the staging directory that also carries fanctl,
# control.py, local.miniarchipel.fanctl.plist and miniarchipel-fanctl.conf.
# Idempotent; everything it replaces is kept beside the new files.
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
[[ $EUID == 0 ]] || { echo 'Run with sudo'; exit 1; }

OLD=/Library/MacMiniFanControl
NEW=/Library/MiniArchipel/FanControl
OLDLOG=/Library/Logs/MacMiniFanControl
NEWLOG=/Library/Logs/MiniArchipel
OLDLABEL=com.macmini.fan-control
NEWLABEL=local.miniarchipel.fanctl
STAGE=$(cd "$(dirname "$0")" && pwd)
TS=$(date +%Y%m%d-%H%M%S)
for f in fanctl control.py "$NEWLABEL.plist" miniarchipel-fanctl.conf local.miniarchipel.fan-control.plist; do
  [[ -f "$STAGE/$f" ]] || { echo "Missing staging artifact: $f" >&2; exit 1; }
done

# Stop the legacy daemon and hand the fan back to the SMC first.
if launchctl print "system/$OLDLABEL" >/dev/null 2>&1; then
  "$OLD/fanctl" auto >/dev/null 2>&1 || true
  launchctl bootout "system/$OLDLABEL"
fi
launchctl disable "system/$OLDLABEL" || true

# Move the payload, merging into the existing state directory.
mkdir -p "$NEW" "$NEWLOG"
if [[ -d "$OLD" ]]; then
  for f in "$OLD"/*; do
    base=$(basename "$f")
    [[ -e "$NEW/$base" ]] && mv "$NEW/$base" "$NEW/$base.pre-migration.$TS"
    mv "$f" "$NEW/"
  done
  rmdir "$OLD"
fi
if [[ -d "$OLDLOG" ]]; then
  for f in "$OLDLOG"/*; do mv "$f" "$NEWLOG/"; done
  rmdir "$OLDLOG"
fi
[[ -f "$NEWLOG/control.log" ]] && mv "$NEWLOG/control.log" "$NEWLOG/fan-control.log"

# Swap the daemon definition and log rotation.
if [[ -f "/Library/LaunchDaemons/$OLDLABEL.plist" ]]; then
  mv "/Library/LaunchDaemons/$OLDLABEL.plist" "/Library/LaunchDaemons/.legacy-$OLDLABEL.$TS.plist"
fi
install -o root -g wheel -m 644 "$STAGE/$NEWLABEL.plist" "/Library/LaunchDaemons/$NEWLABEL.plist"
rm -f /etc/newsyslog.d/macmini-fan-control.conf
install -o root -g wheel -m 644 "$STAGE/miniarchipel-fanctl.conf" "/etc/newsyslog.d/miniarchipel-fanctl.conf"

# Fresh artifacts from the repository build.
install -o root -g wheel -m 755 "$STAGE/fanctl" "$NEW/fanctl.next"
mv "$NEW/fanctl.next" "$NEW/fanctl"
install -o root -g wheel -m 644 "$STAGE/control.py" "$NEW/control.py"

# Restart the root helper that serves the plugin socket, if it is installed.
HELPER_PLIST=/Library/LaunchDaemons/local.miniarchipel.fan-control.plist
if [[ -f "$HELPER_PLIST" ]]; then
  launchctl bootout system/local.miniarchipel.fan-control >/dev/null 2>&1 || true
  install -o root -g wheel -m 644 "$STAGE/local.miniarchipel.fan-control.plist" "$HELPER_PLIST"
  launchctl bootstrap system "$HELPER_PLIST"
  sleep 3
fi

# Start under the new label and verify the fan answers.
launchctl enable "system/$NEWLABEL"
launchctl bootstrap system "/Library/LaunchDaemons/$NEWLABEL.plist"
sleep 3
"$NEW/fanctl" -c "$NEW/fanctl.conf" -j status | /usr/bin/python3 -c '
import json, sys
s = json.load(sys.stdin)
assert s.get("ok") is True, s
assert s.get("temp") is not None, "no temperature reading"
print("fan ok: temp", s.get("temp"), "rpm", s.get("rpm"), "mode", s.get("mode"))
'
echo "Migration complete. Legacy plist kept as .legacy-$OLDLABEL.$TS.plist"
