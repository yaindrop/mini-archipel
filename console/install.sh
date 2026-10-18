#!/bin/bash
# Install an already verified production bundle; configuration and SQLite history stay outside releases.
set -euo pipefail
umask 077
cd "$(dirname "$0")"
[[ -f dist/server.cjs && -f dist/store-worker.cjs && -f dist/web/index.html ]] || { echo 'error: run npm ci && npm run check first'; exit 1; }
NODE_BIN=${NODE_BIN:-$(command -v node)}
[[ -x "$NODE_BIN" ]] || { echo 'error: node not found (set NODE_BIN=)'; exit 1; }
"$NODE_BIN" -e 'const [major, minor] = process.versions.node.split(".").map(Number); if ((major !== 24 && major !== 26) || (major === 24 && minor < 12)) process.exit(1)' || { echo 'error: Node 24.12+ or 26 required'; exit 1; }
LABEL=local.miniarchipel.console
DEST_DIR="$HOME/.local/libexec/mini-archipel-console"
CONF_DIR="$HOME/.config/mini-archipel"
LOG_DIR="$HOME/Library/Logs/MiniArchipel"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
STAGE_DIR="${DEST_DIR}.next"
BACKUP_DIR="${DEST_DIR}.previous"
mkdir -p "$CONF_DIR" "$LOG_DIR" "$HOME/Library/LaunchAgents" "$HOME/.local/share/mini-archipel"
chmod 700 "$CONF_DIR" "$LOG_DIR" "$HOME/.local/share/mini-archipel"
if [[ ! -f "$CONF_DIR/console.json" ]]; then
  UI_TOKEN=$(openssl rand -hex 24)
  umask 077
  cat > "$CONF_DIR/console.json" <<CONFIG
{
  "bind": "127.0.0.1:9100",
  "uiToken": "$UI_TOKEN",
  "dbPath": "$HOME/.local/share/mini-archipel/console.db",
  "hosts": [{ "name": "yd-mini", "kind": "physical", "identity": "", "url": "http://127.0.0.1:9101", "token": "REPLACE_WITH_AGENT_TOKEN" }]
}
CONFIG
  echo "Generated $CONF_DIR/console.json; fill in agent tokens before starting."
  exit 0
fi
# The quoted program is JavaScript; its template expressions must remain literal.
# shellcheck disable=SC2016
HEALTH_URL=$("$NODE_BIN" -e '
  const config = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const [host, port] = config.bind.split(":");
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) process.exit(1);
  console.log(`http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}/api/session`);
' "$CONF_DIR/console.json")
[[ ! -e "$STAGE_DIR" ]] || { echo "error: existing staging directory $STAGE_DIR; inspect it first"; exit 1; }
mkdir -p "$STAGE_DIR/web"
install -m 644 dist/server.cjs "$STAGE_DIR/server.cjs"
install -m 644 dist/store-worker.cjs "$STAGE_DIR/store-worker.cjs"
cp -R dist/web/. "$STAGE_DIR/web/"
# Retain the immediately previous deployment for rollback; archive older backups before rerunning.
if [[ -e "$BACKUP_DIR" ]]; then mv "$BACKUP_DIR" "${BACKUP_DIR}-$(date +%Y%m%d-%H%M%S)"; fi
PLIST_BACKUP="${PLIST}.previous"
if [[ -f "$PLIST" ]]; then cp "$PLIST" "$PLIST_BACKUP"; fi
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
    if [[ -d "$DEST_DIR" ]]; then mv "$DEST_DIR" "${DEST_DIR}.failed-$(date +%Y%m%d-%H%M%S)"; fi
    if [[ -d "$BACKUP_DIR" ]]; then mv "$BACKUP_DIR" "$DEST_DIR"; fi
  fi
  if [[ -f "$PLIST_BACKUP" && -d "$DEST_DIR" ]]; then
    cp "$PLIST_BACKUP" "$PLIST"
    launchctl bootstrap "gui/$(id -u)" "$PLIST" || true
  fi
  echo "error: installation failed; previous release restored when available. See $LOG_DIR/console.log"
  exit "$status"
}
trap rollback ERR
stop_service
if [[ -d "$DEST_DIR" ]]; then mv "$DEST_DIR" "$BACKUP_DIR"; fi
MOVED=true
mv "$STAGE_DIR" "$DEST_DIR"
cat > "$PLIST" <<PLIST_XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>ProgramArguments</key><array><string>$NODE_BIN</string><string>$DEST_DIR/server.cjs</string><string>$CONF_DIR/console.json</string></array>
<key>WorkingDirectory</key><string>$DEST_DIR</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>Umask</key><integer>63</integer>
<key>ThrottleInterval</key><integer>5</integer><key>ExitTimeOut</key><integer>30</integer>
<key>EnvironmentVariables</key><dict><key>https_proxy</key><string>http://127.0.0.1:10808</string><key>http_proxy</key><string>http://127.0.0.1:10808</string></dict>
<key>StandardOutPath</key><string>$LOG_DIR/console.log</string>
<key>StandardErrorPath</key><string>$LOG_DIR/console.log</string>
</dict></plist>
PLIST_XML
launchctl enable "gui/$(id -u)/$LABEL"
STARTED=false
for _ in {1..10}; do
  if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then STARTED=true; break; fi
  sleep 0.5
done
[[ "$STARTED" == true ]]
HEALTHY=false
for _ in {1..40}; do
  if /usr/bin/curl --noproxy '*' --silent --fail --max-time 2 "$HEALTH_URL" >/dev/null; then HEALTHY=true; break; fi
  sleep 0.5
done
[[ "$HEALTHY" == true ]]
trap - ERR
launchctl print "gui/$(id -u)/$LABEL" | sed -n '1,8p'
echo 'Installed mini-archipel console. Open the configured address and enter the access token in the sign-in form.'
