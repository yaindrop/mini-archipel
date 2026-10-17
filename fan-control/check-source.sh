#!/bin/bash
# Verify both immutable provenance layers in a disposable directory.
set -euo pipefail
cd "$(dirname "$0")"
shasum -a 256 -c SHA256SUMS
CHECK_DIR=$(mktemp -d)
trap 'rm -rf "$CHECK_DIR"' EXIT
mkdir -p "$CHECK_DIR/src"
cp src/fanctl.c "$CHECK_DIR/src/"
(cd "$CHECK_DIR" && git apply --reverse "$OLDPWD/patches/archipel.patch" && git apply --reverse "$OLDPWD/patches/m6.patch")
EXPECTED=0d033ebed79e5bf0cbceae023b722a3605256850f5c862ec0f7ad27727159ca8
ACTUAL=$(shasum -a 256 "$CHECK_DIR/src/fanctl.c" | cut -d ' ' -f 1)
[[ "$ACTUAL" == "$EXPECTED" ]]
