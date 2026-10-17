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
fanctl = "/Library/MacMiniFanControl/fanctl"
disk_interval_ms = 21600000
disk_roots = ["~"]
EOF
  echo "Generated $CONF; optional plugins are disabled until configured."
fi
[[ ! -e "$DEST.next" ]] || { echo 'error: existing agent staging file; inspect it first'; exit 1; }
install -m 755 "$BIN" "$DEST.next"
install -m 755 allow-firewall.sh "$HOME/.local/libexec/mini-archipel-firewall.sh"
trap 'rm -f "$DEST.next"' EXIT
BIND=$("$DEST.next" check-config "$CONF")
EXPECTED=$("$DEST.next" --version)
HEALTH_URL="http://${BIND/0.0.0.0/127.0.0.1}/health"
for backup in "$DEST.previous" "$PLIST.previous"; do
  if [[ -e "$backup" ]]; then mv "$backup" "$backup-$(date +%Y%m%d-%H%M%S)"; fi
done
if [[ -f "$PLIST" ]]; then cp "$PLIST" "$PLIST.previous"; fi
rollback() {
  local status=$?
  trap - ERR
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  if [[ -f "$DEST" ]]; then mv "$DEST" "$DEST.failed-$(date +%Y%m%d-%H%M%S)"; fi
  if [[ -f "$DEST.previous" && -f "$PLIST.previous" ]]; then
    mv "$DEST.previous" "$DEST"
    cp "$PLIST.previous" "$PLIST"
    launchctl bootstrap "gui/$(id -u)" "$PLIST" || true
  fi
  echo "error: agent installation failed; previous service restored when available. See $LOG_DIR/agent.log"
  exit "$status"
}
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
for _ in {1..30}; do
  if ! launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then break; fi
  sleep 0.2
done
if [[ -f "$DEST" ]]; then mv "$DEST" "$DEST.previous"; fi
trap rollback ERR
mv "$DEST.next" "$DEST"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>ProgramArguments</key><array><string>$DEST</string><string>$CONF</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
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
