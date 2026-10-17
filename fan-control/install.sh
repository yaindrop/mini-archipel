#!/bin/bash
# Compatibility entry point; build as the user before the root installation.
set -euo pipefail
cd "$(dirname "$0")"
exec ./install-plugin.sh "$@"
