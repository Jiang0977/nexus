#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

RUN_FRONTEND_BUILD=0

while [ "$#" -gt 0 ]; do
    case "$1" in
        --frontend)
            RUN_FRONTEND_BUILD=1
            ;;
        *)
            echo "[Nexus] Unknown argument: $1" >&2
            exit 1
            ;;
    esac
    shift
done

resolve_cargo_bin() {
    if command -v cargo >/dev/null 2>&1; then
        command -v cargo
        return 0
    fi

    local cargo_home_bin="${CARGO_HOME:-${HOME:-$REPO_ROOT}/.cargo}/bin/cargo"
    if [ -x "$cargo_home_bin" ]; then
        printf '%s\n' "$cargo_home_bin"
        return 0
    fi

    echo "[Nexus] cargo not found; install Rust or expose cargo in PATH" >&2
    return 127
}

install_native_session_cli() {
    local cli_target="${REPO_ROOT}/rust-runtime/target/release/nexus-native-session"
    local install_dir="${NEXUS_CLI_INSTALL_DIR:-${HOME}/.local/bin}"
    local cli_link="${install_dir}/nexus-native-session"

    mkdir -p "$install_dir"
    ln -sfn "$cli_target" "$cli_link"
    echo "[Nexus] Installed native session CLI at ${cli_link}"
}

declare -a RELEASE_BINS=(
    "rust-runtime/target/release/nexus-server"
    "rust-runtime/target/release/nexus-task-runtime"
    "rust-runtime/target/release/nexus-pty-runtime"
    "rust-runtime/target/release/nexus-native-pty-supervisor"
    "rust-runtime/target/release/nexus-native-session"
    "rust-runtime/target/release/nexus-window-launch-runtime"
    "rust-runtime/target/release/nexus-session-runtime"
    "rust-runtime/target/release/nexus-codex-home"
)

BACKUP_DIR="$(mktemp -d /tmp/nexus-deploy-backup.XXXXXX)"
RESTORE_NEEDED=0
KEEP_BACKUP=0
RESTART_HELPER="${NEXUS_RESTART_HELPER:-./scripts/restart-nexus-service.sh}"

cleanup() {
    if [ "$KEEP_BACKUP" -eq 0 ] && [ -d "$BACKUP_DIR" ]; then
        rm -rf "$BACKUP_DIR"
    fi
}
trap cleanup EXIT

backup_release_bins() {
    mkdir -p "${BACKUP_DIR}/release"
    for bin_path in "${RELEASE_BINS[@]}"; do
        if [ -f "$bin_path" ]; then
            cp -p "$bin_path" "${BACKUP_DIR}/release/$(basename "$bin_path")"
        fi
    done
}

restore_release_bins() {
    for bin_path in "${RELEASE_BINS[@]}"; do
        local backup_path="${BACKUP_DIR}/release/$(basename "$bin_path")"
        if [ -f "$backup_path" ]; then
            cp -p "$backup_path" "$bin_path"
            chmod +x "$bin_path"
        else
            rm -f "$bin_path"
        fi
    done
}

run_restart_helper() {
    bash "$RESTART_HELPER"
}

if [ "$RUN_FRONTEND_BUILD" -eq 1 ]; then
    echo "[Nexus] Building frontend dist..."
    npm --prefix frontend run build
fi

if [ ! -f frontend/dist/index.html ]; then
    echo "[Nexus] Missing frontend/dist/index.html; build frontend before deploying" >&2
    exit 1
fi

echo "[Nexus] Backing up current release binaries to ${BACKUP_DIR}..."
backup_release_bins
RESTORE_NEEDED=1

CARGO_BIN="$(resolve_cargo_bin)"
echo "[Nexus] Building release binaries..."
"$CARGO_BIN" build --manifest-path rust-runtime/Cargo.toml --release \
    --bin nexus-server \
    --bin nexus-task-runtime \
    --bin nexus-pty-runtime \
    --bin nexus-native-pty-supervisor \
    --bin nexus-native-session \
    --bin nexus-window-launch-runtime \
    --bin nexus-session-runtime \
    --bin nexus-codex-home

install_native_session_cli

if sudo -n systemctl is-active --quiet nexus-native-pty.service; then
    echo "[Nexus] Restarting native PTY supervisor..."
    sudo -n systemctl restart nexus-native-pty.service
    sudo -n systemctl status nexus-native-pty.service --no-pager
fi

echo "[Nexus] Restarting deployed service..."
if run_restart_helper; then
    RESTORE_NEEDED=0
    echo "[Nexus] Deploy complete."
    exit 0
fi

echo "[Nexus] Deploy restart failed; restoring previous release binaries..." >&2
if [ "$RESTORE_NEEDED" -eq 1 ]; then
    restore_release_bins
fi

echo "[Nexus] Restarting rolled-back service..." >&2
if run_restart_helper; then
    KEEP_BACKUP=1
    echo "[Nexus] Rollback completed. Backup kept at ${BACKUP_DIR}" >&2
else
    KEEP_BACKUP=1
    echo "[Nexus] Rollback restart also failed. Backup kept at ${BACKUP_DIR}" >&2
fi

exit 1
