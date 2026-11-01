#!/bin/bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
mode="${1:-install}"
if [[ "$mode" == --help ]]; then
  printf '%s\n' 'install.sh [--upgrade | --rollback BACKUP_DIRECTORY]' \
    'Installs the localized Screen Recorder companion at its fixed portable path.' \
    'Upgrade preserves old App/CLI and legacy data; rollback restores a recorded backup.'
  exit 0
fi
[[ "$mode" == install || "$mode" == --upgrade || "$mode" == --rollback ]] || { echo 'Unknown install mode.' >&2; exit 1; }
[[ $(id -u) != 0 ]] || { echo 'Install as the desktop user, not root.' >&2; exit 1; }
build_root="${ASR_BUILD_DIR:-build}"
source_app="$build_root/Mini Archipel Plugin - Screen Recorder.app"
target_app="$HOME/Applications/Mini Archipel Plugin - Screen Recorder.app"
legacy_app="$HOME/Applications/Agent Screen Recorder.app"
cli="$HOME/.local/bin/agent-screen-recorder"
support="$HOME/Library/Application Support/Agent Screen Recorder"
verify_app() {
  codesign --verify --strict "$1"
  [[ $(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$1/Contents/Info.plist") == org.agent-screen-recorder.app ]] || { echo 'Unexpected companion bundle ID.' >&2; exit 1; }
}
if [[ "$mode" == --rollback ]]; then
  [[ $# == 2 ]] || { echo '--rollback requires a backup directory.' >&2; exit 1; }
  restore="$(cd "$2" && pwd -P)"
  [[ -f "$restore/installer-backup-v1" ]] || { echo 'Not a recorder installer backup.' >&2; exit 1; }
  found=false
  for item in current.app legacy.app; do
    if [[ -d "$restore/$item" ]]; then verify_app "$restore/$item"; found=true; fi
  done
  "$found" || { echo 'Backup contains no previous App to restore.' >&2; exit 1; }
else
  verify_app "$source_app"
  [[ -f "$build_root/agent-screen-recorder" ]] || { echo 'CLI wrapper missing.' >&2; exit 1; }
fi
for item in "$target_app" "$legacy_app"; do
  if [[ -e "$item" ]]; then verify_app "$item"; fi
 done
if [[ "$mode" == install && ( -e "$target_app" || -e "$legacy_app" || -e "$cli" ) ]]; then
  echo 'Existing installation found. Use --upgrade to preserve it and migrate normally.' >&2
  exit 1
fi
mkdir -p "$support" "$support/backups" "$HOME/Applications" "$HOME/.local/bin"
lock="$support/install.lock"
mkdir "$lock" 2>/dev/null || { echo 'Another installation owns the install lock.' >&2; exit 1; }
backup=""; changed=false; success=false
cleanup() {
  status=$?
  if "$changed" && ! "$success"; then
    # Only fixed, identity-checked companion paths are touched; preserve backup.
    rm -rf "$target_app" "$legacy_app"
    rm -f "$cli"
    [[ ! -d "$backup/current.app" ]] || ditto "$backup/current.app" "$target_app"
    [[ ! -d "$backup/legacy.app" ]] || ditto "$backup/legacy.app" "$legacy_app"
    [[ ! -f "$backup/cli" ]] || install -m 755 "$backup/cli" "$cli"
  fi
  rmdir "$lock" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT
state=idle
if [[ -f "$support/state.json" ]]; then
  state="$(/usr/bin/plutil -extract state raw -o - "$support/state.json" 2>/dev/null || printf unknown)"
fi
pending=none
shopt -s nullglob
requests=("$support/requests/"*.request "$support/requests/"*.active)
[[ ${#requests[@]} == 0 ]] || pending=pending
# Native AppKit termination does not send Apple Events or request Automation access.
/usr/bin/osascript -l JavaScript - "$target_app" "$legacy_app" "$state" "$pending" <<'JXA'
ObjC.import('AppKit');
function run(argv) {
  var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('org.agent-screen-recorder.app');
  if (apps.count && (['recording','stopping','processing','unknown'].indexOf(argv[2]) >= 0 || argv[3] === 'pending'))
    throw Error('Companion has active or unverified operations; inspect status and finish them before upgrading.');
  for (var i=0;i<apps.count;i++) {
    var app=apps.objectAtIndex(i), path=app.bundleURL.path.js;
    if (path!==argv[0] && path!==argv[1]) throw Error('A companion from another path is running; close it normally first.');
    if (!app.terminate) throw Error('Idle companion refused normal termination.');
  }
  for (var n=0;n<50;n++) {
    var live=false;
    for(var j=0;j<apps.count;j++) if(!apps.objectAtIndex(j).isTerminated) live=true;
    if(!live) return;
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(.1));
  }
  throw Error('Companion did not terminate normally; installation cancelled.');
}
JXA
backup="$(mktemp -d "$support/backups/upgrade-XXXXXX")"
printf '%s\n' 'recorder-installer-backup-v1' > "$backup/installer-backup-v1"
[[ ! -d "$target_app" ]] || ditto "$target_app" "$backup/current.app"
[[ ! -d "$legacy_app" ]] || ditto "$legacy_app" "$backup/legacy.app"
[[ ! -f "$cli" ]] || cp -p "$cli" "$backup/cli"
changed=true
rm -rf "$target_app" "$legacy_app"
rm -f "$cli"
if [[ "$mode" == --rollback ]]; then
  [[ ! -d "$restore/current.app" ]] || ditto "$restore/current.app" "$target_app"
  [[ ! -d "$restore/legacy.app" ]] || ditto "$restore/legacy.app" "$legacy_app"
  [[ ! -f "$restore/cli" ]] || install -m 755 "$restore/cli" "$cli"
else
  ditto "$source_app" "$target_app"
  install -m 755 "$build_root/agent-screen-recorder" "$cli"
  verify_app "$target_app"
fi
register=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
if [[ -x "$register" ]]; then
  for installed in "$target_app" "$legacy_app"; do
    [[ ! -d "$installed" ]] || "$register" -f "$installed"
  done
fi
success=true
printf 'Installation completed. Previous installation: %s\n' "$backup"
printf '%s\n' 'Bundle ID and legacy data are preserved. Screen/Input permission inheritance must be checked, never assumed.'
