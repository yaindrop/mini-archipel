#!/bin/bash
# Register the current monitoring binary; preserve all other firewall rules.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run with sudo and the target login account.'; exit 1; }
ACCOUNT=${1:-${SUDO_USER:-}}
[[ -n "$ACCOUNT" && "$ACCOUNT" != root && "$ACCOUNT" != */* ]] || { echo 'A non-root login account is required.'; exit 1; }
ACCOUNT_HOME=$(/usr/bin/dscl . -read "/Users/$ACCOUNT" NFSHomeDirectory | /usr/bin/sed 's/^NFSHomeDirectory: //')
AGENT="$ACCOUNT_HOME/.local/libexec/mini-archipel-agent"
[[ -x "$AGENT" ]] || { echo "Agent not found: $AGENT"; exit 1; }
FIREWALL=/usr/libexec/ApplicationFirewall/socketfilterfw
"$FIREWALL" --add "$AGENT"
"$FIREWALL" --unblockapp "$AGENT"
"$FIREWALL" --getappblocked "$AGENT"
echo 'Monitoring firewall registration updated.'
