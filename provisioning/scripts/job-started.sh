#!/bin/bash
set -euo pipefail
exec /usr/bin/python3 "$HOME/.local/libexec/mini-ci/ci-lease.py" start
