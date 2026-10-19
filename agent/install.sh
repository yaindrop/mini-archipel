#!/bin/bash
# Install a verified agent without changing other user services.
set -euo pipefail
umask 077
cd "$(dirname "$0")"
BIN=${BIN:-target/release/mini-archipel-agent}
[[ -x "$BIN" ]] || { echo 'error: build first or set BIN='; exit 1; }
LABEL=local.miniarchipel.agent
DEST="$HOME/.local/libexec/mini-archipel-agent"
CONF="$HOME/.config/mini-archipel/agent.toml"
LOG_DIR="$HOME/Library/Logs/MiniArchipel"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$(dirname "$DEST")" "$(dirname "$CONF")" "$LOG_DIR" "$(dirname "$PLIST")"
mkdir -p "$HOME/.local/share/mini-archipel"
chmod 700 "$(dirname "$CONF")" "$LOG_DIR" "$HOME/.local/share/mini-archipel"
if [[ ! -f "$CONF" ]]; then
  TOKEN=$(openssl rand -hex 24)
  cat > "$CONF" <<EOF
bind = "0.0.0.0:9101"
token = "$TOKEN"
[collectors]
proc_interval_ms = 2000
thermal_interval_ms = 5000
fan_interval_ms = 2000
macmon = "/opt/homebrew/bin/macmon"
fanctl = "/Library/MiniArchipel/FanControl/fanctl"
disk_interval_ms = 21600000
disk_roots = ["~", "/"]
EOF
  echo "Generated $CONF; optional plugins are disabled until configured."
fi
[[ ! -e "$DEST.next" ]] || { echo 'error: existing agent staging file; inspect it first'; exit 1; }
install -m 755 "$BIN" "$DEST.next"
trap 'rm -f "$DEST.next"' EXIT
/usr/bin/codesign --verify --strict "$DEST.next"
SIGNATURE=$(/usr/bin/codesign -dv "$DEST.next" 2>&1)
printf '%s\n' "$SIGNATURE" | /usr/bin/grep -qx 'Identifier=local.miniarchipel.agent' && [[ "$SIGNATURE" != *'Signature=adhoc'* ]] || { echo 'error: a persistent Agent signature is required'; exit 1; }
if [[ -x "$DEST" ]]; then
  REQUIREMENT=$(/usr/bin/codesign -d -r- "$DEST" 2>&1 | sed -n 's/^designated => //p')
  [[ -n "$REQUIREMENT" ]] || { echo 'error: cannot verify the installed signing identity'; rm -f "$DEST.next"; exit 1; }
  /usr/bin/codesign --verify --strict -R "=$REQUIREMENT" "$DEST.next" || { echo 'error: signing identity changed; preserve the existing identity'; rm -f "$DEST.next"; exit 1; }
fi
install -m 755 allow-firewall.sh "$HOME/.local/libexec/mini-archipel-firewall.sh"
BIND=$("$DEST.next" check-config "$CONF")
EXPECTED=$("$DEST.next" --version)
HEALTH_URL="http://${BIND/0.0.0.0/127.0.0.1}/health"
for backup in "$DEST.previous" "$PLIST.previous"; do
  if [[ -e "$backup" ]]; then mv "$backup" "$backup-$(date +%Y%m%d-%H%M%S)"; fi
done
if [[ -f "$PLIST" ]]; then cp "$PLIST" "$PLIST.previous"; fi
STOP_PID=
stop_service() {
  local found_pid stopped=false
  found_pid=$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | awk '/^[[:space:]]*pid = / {print $3; exit}') || true
  if [[ -n "$found_pid" ]]; then STOP_PID=$found_pid; fi
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  for _ in {1..200}; do
    if ! launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && { [[ -z "$STOP_PID" ]] || ! kill -0 "$STOP_PID" 2>/dev/null; }; then stopped=true; break; fi
    sleep 0.2
  done
  [[ "$stopped" == true ]] || return 1
  STOP_PID=
}
MOVED=false
rollback() {
  local status=$?
  trap - ERR
  if ! stop_service; then echo 'error: service still stopping; backups preserved'; exit "$status"; fi
  if [[ "$MOVED" == true ]]; then
    if [[ -f "$DEST" ]]; then mv "$DEST" "$DEST.failed-$(date +%Y%m%d-%H%M%S)"; fi
    if [[ -f "$DEST.previous" ]]; then mv "$DEST.previous" "$DEST"; fi
  fi
  if [[ -f "$PLIST.previous" && -f "$DEST" ]]; then
    cp "$PLIST.previous" "$PLIST"
    launchctl bootstrap "gui/$(id -u)" "$PLIST" || true
  fi
  echo "error: agent installation failed; previous service restored when available. See $LOG_DIR/agent.log"
  exit "$status"
}
trap rollback ERR
stop_service
if [[ -f "$DEST" ]]; then mv "$DEST" "$DEST.previous"; fi
MOVED=true
mv "$DEST.next" "$DEST"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>ProgramArguments</key><array><string>$DEST</string><string>$CONF</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>Umask</key><integer>63</integer>
<key>ThrottleInterval</key><integer>5</integer><key>ProcessType</key><string>Adaptive</string>
<key>StandardOutPath</key><string>$LOG_DIR/agent.log</string>
<key>StandardErrorPath</key><string>$LOG_DIR/agent.log</string>
</dict></plist>
EOF
launchctl enable "gui/$(id -u)/$LABEL"
launchctl bootstrap "gui/$(id -u)" "$PLIST"
HEALTHY=false
for _ in {1..40}; do
  if [[ "$(/usr/bin/curl --noproxy '*' --silent --max-time 2 "$HEALTH_URL" || true)" == "$EXPECTED" ]]; then HEALTHY=true; break; fi
  sleep 0.5
done
[[ "$HEALTHY" == true ]]
trap - ERR
printf 'Installed mini-archipel agent %s; credentials remain in %s\n' "$EXPECTED" "$CONF"

if /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate | /usr/bin/grep -q 'State = 1'; then
  printf 'Verify incoming access. To register the current binary: sudo bash %q %q\n' "$HOME/.local/libexec/mini-archipel-firewall.sh" "$(id -un)"
fi
