#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p test-results
# Compile only isolated test binaries: never replace or launch the signed helper.
arch="$(uname -m)"
xcrun swiftc -target "$arch-apple-macos15.0" -swift-version 5 -parse-as-library Sources/*.swift \
  -framework AppKit -framework ScreenCaptureKit -framework AVFoundation -framework CoreMedia -framework CoreVideo \
  -o test-results/cli-tests
ASR_TEST_BINARY="$PWD/test-results/cli-tests" python3 tests/smoke.py
xcrun swiftc -target "$arch-apple-macos15.0" -swift-version 5 -D TESTING -parse-as-library \
  Sources/Protocol.swift Sources/Pointer.swift Sources/Media.swift Sources/Capture.swift Sources/Service.swift Sources/CLI.swift tests/StateTests.swift \
  -framework AppKit -framework ScreenCaptureKit -framework AVFoundation -framework CoreMedia -framework CoreVideo \
  -o test-results/state-tests
test-results/state-tests
for suite in Pointer Media; do
  xcrun swiftc -target "$arch-apple-macos15.0" -swift-version 5 -parse-as-library \
    Sources/Protocol.swift Sources/Pointer.swift Sources/Media.swift "tests/${suite}Tests.swift" \
    -framework AVFoundation -framework CoreMedia -framework CoreVideo -o "test-results/${suite}-tests"
done
test-results/Pointer-tests
fixture="$(mktemp -d "$PWD/test-results/timeline-XXXXXX")"
trap 'rm -rf "$fixture"' EXIT
test-results/cli-tests --cli self-test-media --output "$fixture/short.mp4"
python3 tests/malformed_timeline.py "$fixture/short.mp4" "$fixture/malformed.mp4"
test-results/Media-tests "$fixture/malformed.mp4" "$fixture/repaired.mp4" 3
if command -v ffprobe >/dev/null; then
  python3 tests/media_timeline.py "$fixture/repaired.mp4" 3
fi

if command -v node >/dev/null; then
  python3 tests/renderer.py
fi
