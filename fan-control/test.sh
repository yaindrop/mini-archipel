#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build
${CC:-clang} -Wall -Wextra -Werror -Wno-unused-parameter -std=c11 tests/test_fanctl.c -o build/test-fanctl
./build/test-fanctl
PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -m unittest discover -s tests -v
