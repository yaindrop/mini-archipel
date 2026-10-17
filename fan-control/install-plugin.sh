#!/bin/bash
# Install the local authority. Build as the user first; only this installation needs sudo.
set -euo pipefail
umask 077
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
cd "$(dirname "$0")"
[[ $EUID == 0 ]] || { echo 'Run with sudo; no sudoers rule is installed.' >&2; exit 1; }
[[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] || exit 1
[[ $(/usr/sbin/sysctl -n hw.model) == Mac18,5 ]] || { echo 'This adapter is verified only for Mac18,5.' >&2; exit 1; }
source deploy/services.sh
AGENT_USER=${1:-${SUDO_USER:-}}
[[ -n "$AGENT_USER" && "$AGENT_USER" != root ]] || { echo 'Supply the Agent account name.' >&2; exit 1; }
AGENT_UID=$(id -u "$AGENT_USER")
AGENT_GID=$(id -g "$AGENT_USER")
[[ $AGENT_UID -ge 500 ]] || exit 1
[[ -x build/fanctl && -x /usr/bin/python3 ]] || { echo 'Build fanctl as the user first.' >&2; exit 1; }
/usr/bin/python3 -I -c 'import ctypes,json,socketserver,threading; assert hasattr(ctypes.CDLL(None), "getpeereid")'
/usr/bin/codesign --verify build/fanctl
DEST=/Library/MacMiniFanControl
CONTROL=local.miniarchipel.fan-control
CURVE=com.macmini.fan-control
BACKUP="/Library/Application Support/MiniArchipel/FanControl/backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP" "$DEST" /Library/Logs/MacMiniFanControl /Library/MiniArchipel/FanControl
chmod 700 "$BACKUP" /Library/MiniArchipel/FanControl
for file in fanctl control.py fanctl.conf; do
  if [[ -f "$DEST/$file" ]]; then cp -p "$DEST/$file" "$BACKUP/$file"; fi
done
for label in "$CONTROL" "$CURVE"; do
  if [[ -f /Library/LaunchDaemons/$label.plist ]]; then cp -p "/Library/LaunchDaemons/$label.plist" "$BACKUP/$label.plist"; fi
done
if [[ -f /Library/MiniArchipel/FanControl/control.json ]]; then cp -p /Library/MiniArchipel/FanControl/control.json "$BACKUP/control.json"; fi
rollback() {
  local status=$?
  trap - ERR
  stop_service "$CONTROL" || true
  stop_service "$CURVE" || true
  "$DEST/fanctl" auto >/dev/null 2>&1 || true
  for file in fanctl control.py fanctl.conf; do
    if [[ -f "$BACKUP/$file" ]]; then cp -p "$BACKUP/$file" "$DEST/$file.next"; mv "$DEST/$file.next" "$DEST/$file"; fi
  done
  if [[ -f "$BACKUP/control.json" ]]; then cp -p "$BACKUP/control.json" /Library/MiniArchipel/FanControl/control.json; fi
  for label in "$CURVE" "$CONTROL"; do
    if [[ -f "$BACKUP/$label.plist" ]]; then
      cp -p "$BACKUP/$label.plist" "/Library/LaunchDaemons/$label.plist"
      start_service "$label" || true
    fi
  done
  echo "Installation failed; restored available backups from $BACKUP" >&2
  exit "$status"
}
trap rollback ERR
stop_service "$CONTROL"
stop_service "$CURVE"
if [[ -x "$DEST/fanctl" ]]; then "$DEST/fanctl" auto; fi
install -o root -g wheel -m 755 build/fanctl "$DEST/fanctl.next"
mv "$DEST/fanctl.next" "$DEST/fanctl"
install -o root -g wheel -m 644 control.py "$DEST/control.py"
install -o root -g wheel -m 755 deploy/stop.sh "$DEST/stop.sh"
install -o root -g wheel -m 644 deploy/verify-hardware.py "$DEST/verify-hardware.py"
install -o root -g wheel -m 644 deploy/newsyslog.d/macmini-fan-control.conf /etc/newsyslog.d/macmini-fan-control.conf
if [[ ! -f "$DEST/fanctl.conf" ]]; then install -o root -g wheel -m 644 config/fanctl.conf "$DEST/fanctl.conf"; fi
chown root:wheel "$DEST" "$DEST/fanctl.conf"
chmod 755 "$DEST"
chmod 644 "$DEST/fanctl.conf"
/usr/bin/python3 -I - "$AGENT_UID" "$AGENT_GID" <<'PY'
import json,os,sys,tempfile
from pathlib import Path
path=Path('/Library/MiniArchipel/FanControl/control.json')
settings={'agent_uid':int(sys.argv[1]),'agent_gid':int(sys.argv[2]),'write_keys':['F0md','F0Tg']}
if path.exists():
    previous=json.loads(path.read_text())
    settings['write_keys']=previous.get('write_keys',[])
fd,name=tempfile.mkstemp(dir=path.parent)
with os.fdopen(fd,'w') as f:
    json.dump(settings,f);f.flush();os.fsync(f.fileno())
os.replace(name,path)
PY
for label in "$CURVE" "$CONTROL"; do
  install -o root -g wheel -m 644 "deploy/$label.plist" "/Library/LaunchDaemons/$label.plist"
  start_service "$label"
done
/usr/bin/sudo -u "$AGENT_USER" /usr/bin/python3 -I - <<'PY'
import json,socket,time
for _ in range(60):
    try:
        with socket.socket(socket.AF_UNIX) as s:
            s.settimeout(2);s.connect('/var/run/mini-archipel/fan-control.sock');s.sendall(b'{"op":"read"}\n')
            raw=b''
            while True:
                part=s.recv(65536)
                if not part:break
                raw+=part
            state=json.loads(raw)
            assert state['ok'] and state['data']['telemetry']['runtime']
            assert state['data']['telemetry']['reading']['have_temp']
            print('Fan-control authority ready; hardware and control loop confirmed.')
            break
    except (OSError,ValueError,AssertionError,TypeError,KeyError):
        time.sleep(.5)
else:
    raise SystemExit('Fan-control health check failed')
PY
trap - ERR
printf 'Installed for %s (UID %s). Rollback backup: %s\n' "$AGENT_USER" "$AGENT_UID" "$BACKUP"
