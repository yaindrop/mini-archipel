#!/bin/bash
# Install the mini-fleet agent as a user LaunchAgent.
# Usage: sudo NOT required. Run ./build.sh first or pass a prebuilt binary.
set -euo pipefail
cd "$(dirname "$0")"

BIN=${BIN:-target/release/mini-fleet-agent}
[[ -x "$BIN" ]] || { echo "error: build first with ./build.sh (or set BIN=)"; exit 1; }

LABEL=local.minifleet.agent
DEST_DIR="$HOME/.local/libexec"
CONF_DIR="$HOME/.config/mini-fleet"
LOG_DIR="$HOME/Library/Logs/MiniFleet"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$DEST_DIR" "$CONF_DIR" "$LOG_DIR"
install -m 755 "$BIN" "$DEST_DIR/mini-fleet-agent"

if [[ ! -f "$CONF_DIR/agent.toml" ]]; then
  TOKEN=$(openssl rand -hex 24)
  cat > "$CONF_DIR/agent.toml" <<EOF
# mini-fleet agent configuration
bind = "0.0.0.0:9101"
token = "$TOKEN"

[collectors]
proc_interval_ms = 2000
thermal_interval_ms = 5000
fan_interval_ms = 2000
macmon = "/opt/homebrew/bin/macmon"
fanctl = "/Library/MacMiniFanControl/fanctl"
disk_interval_ms = 900000
disk_roots = ["~"]
EOF
  chmod 600 "$CONF_DIR/agent.toml"
  echo "generated $CONF_DIR/agent.toml with fresh token"
else
  echo "keeping existing $CONF_DIR/agent.toml"
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>ProgramArguments</key><array>
<string>$DEST_DIR/mini-fleet-agent</string>
<string>$CONF_DIR/agent.toml</string>
</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>5</integer>
<key>ProcessType</key><string>Adaptive</string>
<key>StandardOutPath</key><string>$LOG_DIR/agent.log</string>
<key>StandardErrorPath</key><string>$LOG_DIR/agent.log</string>
</dict></plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 2
launchctl print "gui/$(id -u)/$LABEL" | grep -E '^\s*state'
echo "agent installed. Token: $(grep '^token' "$CONF_DIR/agent.toml" | cut -d'"' -f2)"
echo "status:   curl -H \"Authorization: Bearer <token>\" http://<host>:9101/snapshot"
