#!/bin/bash
# Build the agent for Apple Silicon. CommandLineTools suffices.
set -euo pipefail
cd "$(dirname "$0")"
cargo build --release
./target/release/mini-fleet-agent --version 2>/dev/null || true
ls -lh target/release/mini-fleet-agent
