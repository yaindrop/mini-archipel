#!/bin/bash
# Build the agent for Apple Silicon. CommandLineTools suffices.
set -euo pipefail
cd "$(dirname "$0")"
cargo build --release --locked
./sign-local.sh
./target/release/mini-archipel-agent --version 2>/dev/null || true
ls -lh target/release/mini-archipel-agent
