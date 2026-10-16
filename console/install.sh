#!/bin/bash
# Install the console as a user LaunchAgent on the fleet host.
# Run from a checkout after `npm run build`; only node + the bundle are needed.
set -euo pipefail
cd "$(dirname "$0")"

[[ -f dist/server.cjs ]] || { echo "error: run npm install && npm run build first"; exit 1; }
NODE_BIN=${NODE_BIN:-$(command -v node)}
[[ -x "$NODE_BIN" ]] || { echo "error: node not found (set NODE_BIN=)"; exit 1; }

LABEL=local.minifleet.console
DEST_DIR="$HOME/.local/libexec/mini-fleet-console"
CONF_DIR="$HOME/.config/mini-fleet"
LOG_DIR="$HOME/Library/Logs/MiniFleet"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$DEST_DIR/web" "$CONF_DIR" "$LOG_DIR"
install -m 644 dist/server.cjs "$DEST_DIR/server.js"
install -m 644 dist/web/app.js dist/web/styles.css "$DEST_DIR/web/"
install -m 644 public/index.html "$DEST_DIR/web/index.html"

if [[ ! -f "$CONF_DIR/console.json" ]]; then
  UI_TOKEN=$(openssl rand -hex 24)
  cat > "$CONF_DIR/console.json" <<EOF
{
  "bind": "0.0.0.0:9100",
  "uiToken": "$UI_TOKEN",
  "dbPath": "$HOME/.local/share/mini-fleet/console.db",
  "hosts": [
    { "name": "mini-1", "url": "http://mini-1.local:9101", "token": "REPLACE_WITH_AGENT_TOKEN" },
    { "name": "mini-2", "url": "http://mini-2.local:9101", "token": "REPLACE_WITH_AGENT_TOKEN" }
  ]
}
EOF
  chmod 600 "$CONF_DIR/console.json"
  mkdir -p "$HOME/.local/share/mini-fleet"
  echo "generated $CONF_DIR/console.json — fill in agent tokens"
else
  echo "keeping existing $CONF_DIR/console.json"
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>ProgramArguments</key><array>
<string>$NODE_BIN</string>
<string>$DEST_DIR/server.js</string>
<string>$CONF_DIR/console.json</string>
</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>5</integer>
<key>WorkingDirectory</key><string>$DEST_DIR</string>
<key>StandardOutPath</key><string>$LOG_DIR/console.log</string>
<key>StandardErrorPath</key><string>$LOG_DIR/console.log</string>
</dict></plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 2
launchctl print "gui/$(id -u)/$LABEL" | grep -E '^\s*state'
echo "console installed: http://$(hostname -s).local:9100/?token=$(grep -o '"uiToken": "[^"]*"' "$CONF_DIR/console.json" | cut -d'"' -f4)"
