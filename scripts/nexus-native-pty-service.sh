#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

read_env_value() {
    local key="$1"
    local line
    line=$(grep -E "^${key}=" .env 2>/dev/null | tail -n 1 || true)
    if [ -n "$line" ]; then
        printf '%s' "${line#*=}" | tr -d '\r'
    fi
}

resolve_data_dir() {
    local configured="${NEXUS_DATA_DIR:-}"
    if [ -z "$configured" ]; then
        configured="$(read_env_value NEXUS_DATA_DIR || true)"
    fi
    if [ -z "$configured" ]; then
        printf '%s\n' "$ROOT_DIR/data"
    elif [[ "$configured" = /* ]]; then
        printf '%s\n' "$configured"
    else
        printf '%s\n' "$ROOT_DIR/$configured"
    fi
}

resolve_session_backend() {
    if [ -n "${NEXUS_SESSION_BACKEND:-}" ]; then
        printf '%s' "$NEXUS_SESSION_BACKEND"
        return
    fi

    local configured
    configured="$(read_env_value NEXUS_SESSION_BACKEND || true)"
    if [ -n "$configured" ]; then
        printf '%s' "$configured"
        return
    fi

    local data_dir
    data_dir="$(resolve_data_dir)"
    if [ -f "$data_dir/session-backend.json" ]; then
        python3 - "$data_dir/session-backend.json" <<'PY' 2>/dev/null || true
import json
import sys
try:
    with open(sys.argv[1], "r", encoding="utf-8") as handle:
        print(json.load(handle).get("session_backend", ""))
except Exception:
    pass
PY
        return
    fi
}

supervisor="${NEXUS_NATIVE_PTY_SUPERVISOR_EXECUTABLE:-$ROOT_DIR/rust-runtime/target/release/nexus-native-pty-supervisor}"
while true; do
    backend="$(resolve_session_backend | tr '[:upper:]' '[:lower:]')"
    if [ "$backend" != "native" ]; then
        sleep 5
        continue
    fi

    if [ ! -x "$supervisor" ]; then
        echo "nexus native pty supervisor executable is missing or not executable: $supervisor" >&2
        exit 1
    fi

    data_dir="$(resolve_data_dir)"
    export NEXUS_SESSION_BACKEND=native
    export NEXUS_DATA_DIR="$data_dir"
    export NEXUS_NATIVE_PTY_SUPERVISOR_SOCKET="${NEXUS_NATIVE_PTY_SUPERVISOR_SOCKET:-$data_dir/native-sessions/supervisor.sock}"

    mkdir -p "$(dirname "$NEXUS_NATIVE_PTY_SUPERVISOR_SOCKET")"
    exec "$supervisor"
done
