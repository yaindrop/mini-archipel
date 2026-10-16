#!/bin/bash
# Install the daemon on the target Mac mini. Run with sudo.
set -euo pipefail
cd "$(dirname "$0")"
die() { echo "error: $*" >&2; exit 1; }
[[ $EUID == 0 ]] || die "run with sudo: sudo $0"
[[ "$(uname -s)" == Darwin ]] || die "macOS only"
[[ "$(uname -m)" == arm64 ]] || die "this build targets Apple Silicon"

DEST=/Library/MacMiniFanControl
LABEL=com.macmini.fan-control
PLIST=/Library/LaunchDaemons/$LABEL.plist
LOGDIR=/Library/Logs/MacMiniFanControl

echo ">> building"
./build.sh

echo ">> stopping any previous instance (hands fan back to Apple auto)"
launchctl print system/$LABEL >/dev/null 2>&1 && launchctl bootout system/$LABEL || true
$DEST/fanctl auto >/dev/null 2>&1 || true

echo ">> installing files"
mkdir -p $DEST $LOGDIR
install -m 755 build/fanctl $DEST/fanctl
[ -f $DEST/fanctl.conf ] || install -m 644 config/fanctl.conf $DEST/fanctl.conf
install -m 755 deploy/stop.sh $DEST/stop.sh
install -m 644 deploy/verify-hardware.py $DEST/verify-hardware.py
install -m 644 LICENSE $DEST/LICENSE
mkdir -p $DEST/src $DEST/patches
install -m 644 src/*.c src/*.h $DEST/src/
install -m 644 patches/m6.patch $DEST/patches/
install -m 644 deploy/$LABEL.plist $PLIST
chown root:wheel $PLIST && chmod 644 $PLIST
install -m 644 deploy/newsyslog.d/macmini-fan-control.conf /etc/newsyslog.d/
chown root:wheel /etc/newsyslog.d/macmini-fan-control.conf

echo ">> hardware check (four fan steps; Apple auto is restored afterwards)"
python3 $DEST/verify-hardware.py

echo ">> starting daemon"
launchctl bootstrap system $PLIST
sleep 2
launchctl print system/$LABEL | grep -E '^\s*(state|pid)'
$DEST/fanctl -c $DEST/fanctl.conf -j status
echo ">> installed. Reload after config edits:"
echo "   sudo launchctl kill TERM system/$LABEL   # then verify the NEW pid"
