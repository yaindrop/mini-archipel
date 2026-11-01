#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p test-results
# The compile flag makes every default OS-post path throw. IO is injected in tests.
for suite in InputTests InputNegativeTests ChatKeyboardTests; do
  xcrun swiftc -parse-as-library -swift-version 5 -D INPUT_TESTING runtime/input/*.swift "tests/$suite.swift" -o "test-results/$suite"
  "test-results/$suite"
done

# Build the real chat helpers without launching them; they share the owned key engine.
for helper in codex-ui zcode-ui; do
  xcrun swiftc -parse-as-library -swift-version 5 "runtime/$helper.swift" runtime/input/{Payload,InputControl,InputState,ChatKeyboard}.swift -o "test-results/$helper"
done
