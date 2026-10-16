#!/bin/bash
# Build the fanctl daemon for Apple Silicon. Verified with Apple clang 21
# (clang-2100.3.34.2) on macOS 27. CommandLineTools is sufficient.
set -euo pipefail
cd "$(dirname "$0")"
CC=${CC:-clang}
ARCHS=${ARCHS:-arm64}
mkdir -p build
# shellcheck disable=SC2086
$CC -O2 -Wall -Wextra -Wno-unused-parameter -std=c11 \
  $([ "$ARCHS" = "all" ] && echo "-arch arm64 -arch x86_64" || echo "-arch $ARCHS") \
  -mmacosx-version-min=11.0 -o build/fanctl \
  src/smc.c src/fanctl.c -framework IOKit -framework CoreFoundation
strip -x build/fanctl 2>/dev/null || true
./build/fanctl | head -1
echo "built: $(file build/fanctl)"
