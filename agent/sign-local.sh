#!/bin/bash
# Sign a release with an existing scoped identity; no trust or privacy database changes.
set -euo pipefail
cd "$(dirname "$0")"
BIN=${1:-target/release/mini-archipel-agent}
: "${ARCHIPEL_SIGN_IDENTITY:?Set a code-signing identity fingerprint}"
: "${ARCHIPEL_SIGN_KEYCHAIN:?Set its dedicated keychain path}"
[[ -f "$BIN" && -f "$ARCHIPEL_SIGN_KEYCHAIN" ]]
/usr/bin/codesign --force --sign "$ARCHIPEL_SIGN_IDENTITY" --keychain "$ARCHIPEL_SIGN_KEYCHAIN" \
  --identifier local.miniarchipel.agent --timestamp=none "$BIN"
/usr/bin/codesign --verify --strict "$BIN"
/usr/bin/codesign -d -r- "$BIN"
