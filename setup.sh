#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

exec cargo run --manifest-path rust-runtime/Cargo.toml --release --bin nexus-setup -- "$@"
