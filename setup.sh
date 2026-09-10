#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Release archives carry all binaries and do not need a Rust toolchain.
if [ -f rust-runtime/Cargo.toml ]; then
    cargo build --locked --manifest-path rust-runtime/Cargo.toml --release --bins
fi
exec ./rust-runtime/target/release/nexus-setup "$@"
