#!/bin/bash
# Sign a release with an existing scoped identity; no trust or privacy database changes.
set -euo pipefail
cd "$(dirname "$0")"
BIN=${1:-target/release/mini-archipel-agent}
ARCHIPEL_SIGN_KEYCHAIN=${ARCHIPEL_SIGN_KEYCHAIN:-$HOME/Library/Keychains/mini-archipel-signing.keychain-db}
if [[ -z "${ARCHIPEL_SIGN_IDENTITY:-}" && -f "$HOME/.local/share/mini-archipel/signing/identity.pem" ]]; then
  ARCHIPEL_SIGN_IDENTITY=$(openssl x509 -in "$HOME/.local/share/mini-archipel/signing/identity.pem" -noout -fingerprint -sha1 | cut -d= -f2 | tr -d ':')
fi
: "${ARCHIPEL_SIGN_IDENTITY:?Prepare the persistent identity as described in SIGNING.md}"
[[ -f "$BIN" && -f "$ARCHIPEL_SIGN_KEYCHAIN" ]]
if [[ -f "$HOME/.local/share/mini-archipel/signing/keychain-password" ]]; then
  /usr/bin/python3 - "$ARCHIPEL_SIGN_KEYCHAIN" <<'PY'
from pathlib import Path
import shlex,subprocess,sys
password=(Path.home()/'.local/share/mini-archipel/signing/keychain-password').read_text()
command='unlock-keychain -p '+shlex.quote(password)+' '+shlex.quote(sys.argv[1])+'\n'
p=subprocess.run(['/usr/bin/security','-i'],input=command,text=True,capture_output=True)
if p.returncode:raise SystemExit('Could not unlock the scoped signing keychain')
PY
fi
/usr/bin/codesign --force --sign "$ARCHIPEL_SIGN_IDENTITY" --keychain "$ARCHIPEL_SIGN_KEYCHAIN" \
  --identifier local.miniarchipel.agent --timestamp=none "$BIN"
/usr/bin/codesign --verify --strict "$BIN"
/usr/bin/codesign -d -r- "$BIN"
