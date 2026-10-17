#!/bin/bash
# launchctl bootout returns before the previous service has fully exited.
stop_service() {
  local label=$1 previous_pid
  previous_pid=$(launchctl print "system/$label" 2>/dev/null | awk '/^[[:space:]]*pid = / { print $3; exit }') || true
  launchctl bootout "system/$label" 2>/dev/null || true
  for _ in {1..100}; do
    if ! launchctl print "system/$label" >/dev/null 2>&1; then
      if [[ -z "$previous_pid" ]] || ! kill -0 "$previous_pid" 2>/dev/null; then return 0; fi
    fi
    sleep 0.2
  done
  echo "Service did not finish stopping: $label" >&2
  return 1
}
start_service() {
  local label=$1
  launchctl enable "system/$label"
  for _ in {1..20}; do
    if launchctl bootstrap system "/Library/LaunchDaemons/$label.plist" 2>/dev/null; then return 0; fi
    sleep 0.5
  done
  echo "Service could not be started: $label" >&2
  return 1
}
