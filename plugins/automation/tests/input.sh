#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p test-results
# The compile flag makes every default OS-post path throw. IO is injected in tests.
for suite in InputTests InputNegativeTests; do
  xcrun swiftc -parse-as-library -swift-version 5 -D INPUT_TESTING runtime/input/*.swift "tests/$suite.swift" -o "test-results/$suite"
  "test-results/$suite"
done
