#!/bin/bash
set -uo pipefail
# Keep the node lease until maintenance finishes. A dead Worker lease self-recovers.
if ! /usr/bin/python3 "$HOME/.local/libexec/mini-archipel/ci/ci-housekeeping.py"; then
  printf '%s\n' '::warning::mini-archipel/ci maintenance failed; see node maintenance history.'
fi
/usr/bin/python3 "$HOME/.local/libexec/mini-archipel/ci/ci-lease.py" complete || {
  printf '%s\n' '::warning::mini-archipel/ci lease will recover after this Worker exits.'
}
exit 0
