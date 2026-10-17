#!/bin/bash
set -uo pipefail
# Keep the node lease until maintenance finishes. A dead Worker lease self-recovers.
if ! /usr/bin/python3 "$HOME/.local/libexec/mini-ci/ci-housekeeping.py"; then
  printf '%s\n' '::warning::mini-ci maintenance failed; see node maintenance history.'
fi
/usr/bin/python3 "$HOME/.local/libexec/mini-ci/ci-lease.py" complete || {
  printf '%s\n' '::warning::mini-ci lease will recover after this Worker exits.'
}
exit 0
