#!/bin/bash

# Nexus deploy script.
# Builds release binaries from this checkout, syncs them to the runtime install
# tree (auto-discovered from nexus.service.WorkingDirectory or
# NEXUS_INSTALL_ROOT), syncs the vendored frontend/dist into the install
# tree, and invokes the configured restart helper. On any failure it restores
# both checkout and install tree to their pre-deploy snapshot before
# re-invoking the restart helper, so a half-applied deploy cannot leave
# nexus serving mixed binaries / assets.
#
# Cutover semantics (see sync_install_tree_frontend / sync_release_bin_to_install):
#   - Release binaries are staged in INSTALL_ROOT/<dir>/.<basename>.XXXXXX and
#     renamed into place. The install tree always points at either the old
#     binary or the new one; on any cp / chmod / mv failure the exact temp
#     file is removed before returning.
#   - frontend/dist is staged into INSTALL_ROOT/frontend/.dist-staging, then
#     the prior dist is renamed to .dist-prev and .dist-staging is renamed
#     into dist, then .dist-prev is removed. This is a staged cutover, not an
#     atomic directory swap: there is a brief window between the two renames
#     where dist/ does not exist on disk, and a brief window before the
#     .dist-prev cleanup where both dist/ and .dist-prev/ exist. Readers never
#     observe a half-populated dist/.
#   - When --restart-native-pty has restarted nexus-native-pty.service and a
#     later Nexus restart/healthcheck fails, the rollback path restarts the
#     native supervisor again so the live process is back on the restored
#     (previous) binary.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"
source "$SCRIPT_DIR/nexus-systemd.sh"
nexus_resolve_service_scope

RUN_FRONTEND_BUILD=0
RESTART_NATIVE_PTY=0

while [ "$#" -gt 0 ]; do
    case "$1" in
        --frontend)
            RUN_FRONTEND_BUILD=1
            ;;
        --restart-native-pty)
            RESTART_NATIVE_PTY=1
            ;;
        *)
            echo "[Nexus] Unknown argument: $1" >&2
            exit 1
            ;;
    esac
    shift
done

declare -a RELEASE_BINS=(
    "rust-runtime/target/release/nexus-server"
    "rust-runtime/target/release/nexus-pty-runtime"
    "rust-runtime/target/release/nexus-native-pty-supervisor"
    "rust-runtime/target/release/nexus-native-session"
    "rust-runtime/target/release/nexus-window-launch-runtime"
    "rust-runtime/target/release/nexus-session-runtime"
    "rust-runtime/target/release/nexus-codex-home"
)

# Marker rules for an independent install tree: .env must be a regular file,
# start.sh must be a regular file, and frontend/ must be a directory. All
# three must be present; partial matches are rejected.
declare -a INSTALL_MARKER_FILES=(
    ".env"
    "start.sh"
)
INSTALL_MARKER_DIR="frontend"

BACKUP_DIR="$(mktemp -d /tmp/nexus-deploy-backup.XXXXXX)"
RESTORE_NEEDED=0
KEEP_BACKUP=0
NATIVE_RESTART_DONE=0
RESTART_HELPER="${NEXUS_RESTART_HELPER:-./scripts/restart-nexus-service.sh}"
SERVICE_NAME="${NEXUS_SERVICE_NAME:-nexus}"

cleanup() {
    if [ "$KEEP_BACKUP" -eq 0 ] && [ -d "$BACKUP_DIR" ]; then
        rm -rf "$BACKUP_DIR"
    fi
}

# Top-level error trap: any uncaught failure inside this script must attempt
# the same restore+rollback path the explicit restart-failure branch uses, so
# a build/sync/health failure does not leave the install tree partially
# rewritten. Disable ERR while running the trap to avoid recursion; restore
# on exit.
on_error() {
    local exit_code=$?
    set +e
    set +E
    trap - ERR
    if [ "$RESTORE_NEEDED" -eq 1 ]; then
        echo "[Nexus] Deploy aborted (exit ${exit_code}); restoring previous binaries and frontend..." >&2
        restore_release_bins
        restore_install_frontend || true
        rollback_native_pty_supervisor || true
        bash "$RESTART_HELPER" || true
        KEEP_BACKUP=1
    fi
    exit "$exit_code"
}

trap 'on_error' ERR
trap 'cleanup' EXIT

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

# Resolve the runtime install root:
#  1. NEXUS_INSTALL_ROOT if set (and validated)
#  2. systemctl show nexus.service WorkingDirectory (read-only — systemctl
#     show is a query and does not require root; do not wrap it in sudo)
#  3. REPO_ROOT (single-tree legacy fallback: checkout == install tree)
# Rejects empty, root '/', or any path that does not look like a Nexus
# install tree. When the install root is independent of the checkout, .env
# (file), start.sh (file), and frontend/ (directory) must all be present.
resolve_install_root() {
    local candidate=""
    local source="default"

    if [ -n "${NEXUS_INSTALL_ROOT:-}" ]; then
        candidate="${NEXUS_INSTALL_ROOT}"
        source="NEXUS_INSTALL_ROOT"
    elif command -v systemctl >/dev/null 2>&1; then
        local discovered=""
        # systemctl show is a read-only query; do not wrap it in sudo.
        discovered="$(nexus_systemctl_query show "${SERVICE_NAME}.service" -p WorkingDirectory --value 2>/dev/null || true)"
        if [ -n "$discovered" ] && [ "$discovered" != "/" ]; then
            candidate="$discovered"
            source="systemd:${SERVICE_NAME}.service"
        fi
    fi

    if [ -z "$candidate" ]; then
        candidate="${REPO_ROOT}"
        source="REPO_ROOT-fallback"
    fi

    # Reject empty / root early.
    if [ -z "$candidate" ]; then
        echo "[Nexus] install root resolved to empty string; refusing to deploy" >&2
        return 1
    fi
    # Disallow filesystem root explicitly.
    local normalized
    normalized="$(cd "$candidate" 2>/dev/null && pwd -P || true)"
    if [ -z "$normalized" ]; then
        echo "[Nexus] install root ${candidate} does not exist or is not accessible" >&2
        return 1
    fi
    if [ "$normalized" = "/" ]; then
        echo "[Nexus] install root resolved to filesystem root '/'; refusing to deploy" >&2
        return 1
    fi
    if [ ! -d "$normalized" ]; then
        echo "[Nexus] install root ${normalized} is not a directory" >&2
        return 1
    fi

    # When the install root is independent of the checkout, require it to
    # look like a Nexus install tree before we write into it.
    if [ "$normalized" != "$REPO_ROOT" ]; then
        local missing=()
        local marker
        for marker in "${INSTALL_MARKER_FILES[@]}"; do
            if [ ! -f "${normalized}/${marker}" ]; then
                missing+=("${marker} (file)")
            fi
        done
        if [ ! -d "${normalized}/${INSTALL_MARKER_DIR}" ]; then
            missing+=("${INSTALL_MARKER_DIR}/ (directory)")
        fi
        if [ "${#missing[@]}" -gt 0 ]; then
            echo "[Nexus] install root ${normalized} (from ${source}) does not look like a Nexus install tree" >&2
            echo "[Nexus] missing required marker(s): ${missing[*]}" >&2
            return 1
        fi
    fi

    printf '%s\n' "$normalized"
    return 0
}

backup_release_bins() {
    mkdir -p "${BACKUP_DIR}/checkout/release"
    mkdir -p "${BACKUP_DIR}/install/release"
    mkdir -p "${BACKUP_DIR}/install/frontend/dist"
    for bin_path in "${RELEASE_BINS[@]}"; do
        local name
        name="$(basename "$bin_path")"
        if [ -f "$bin_path" ]; then
            cp -p "$bin_path" "${BACKUP_DIR}/checkout/release/${name}"
        fi
        if [ "$INSTALL_ROOT" != "$REPO_ROOT" ]; then
            local install_bin="${INSTALL_ROOT}/${bin_path}"
            if [ -f "$install_bin" ]; then
                cp -p "$install_bin" "${BACKUP_DIR}/install/release/${name}"
            fi
        fi
    done
    if [ "$INSTALL_ROOT" != "$REPO_ROOT" ] && [ -d "${INSTALL_ROOT}/frontend/dist" ]; then
        # Stage a verbatim copy so restore can put every file back exactly.
        cp -a "${INSTALL_ROOT}/frontend/dist/." "${BACKUP_DIR}/install/frontend/dist/"
    fi
}

restore_release_bins() {
    local bin_path name
    for bin_path in "${RELEASE_BINS[@]}"; do
        name="$(basename "$bin_path")"
        local checkout_backup="${BACKUP_DIR}/checkout/release/${name}"
        if [ -f "$checkout_backup" ]; then
            cp -p "$checkout_backup" "$bin_path"
            chmod +x "$bin_path"
        else
            rm -f "$bin_path"
        fi
        if [ "$INSTALL_ROOT" != "$REPO_ROOT" ]; then
            local install_bin="${INSTALL_ROOT}/${bin_path}"
            local install_backup="${BACKUP_DIR}/install/release/${name}"
            if [ -f "$install_backup" ]; then
                cp -p "$install_backup" "$install_bin"
                chmod +x "$install_bin"
            else
                rm -f "$install_bin"
            fi
        fi
    done
}

# Copy a single release binary into the install tree. Stage the new bytes
# in a temp file next to the destination, chmod it, then rename into place.
# Each step is guarded by an explicit if so that any failure cleans up the
# exact temp file we created. On failure the destination directory must not
# be left with a stale .<basename>.XXXXXX dotfile.
sync_release_bin_to_install() {
    local rel_path="$1"
    local src="${REPO_ROOT}/${rel_path}"
    local dst="${INSTALL_ROOT}/${rel_path}"
    local dst_dir
    dst_dir="$(dirname "$dst")"
    mkdir -p "$dst_dir"
    local tmp
    tmp="$(mktemp "${dst_dir}/.$(basename "$dst").XXXXXX")"
    if ! cp -p "$src" "$tmp"; then
        rm -f "$tmp"
        echo "[Nexus] failed to stage ${rel_path} into ${dst_dir}" >&2
        return 1
    fi
    if ! chmod +x "$tmp"; then
        rm -f "$tmp"
        echo "[Nexus] failed to chmod staged ${rel_path}" >&2
        return 1
    fi
    if ! mv -f "$tmp" "$dst"; then
        rm -f "$tmp"
        echo "[Nexus] failed to rename staged ${rel_path} into place" >&2
        return 1
    fi
}

sync_release_bins_to_install() {
    if [ "$INSTALL_ROOT" = "$REPO_ROOT" ]; then
        return 0
    fi
    local bin_path
    for bin_path in "${RELEASE_BINS[@]}"; do
        if ! sync_release_bin_to_install "$bin_path"; then
            return 1
        fi
    done
}

# Sync checkout frontend/dist into INSTALL_ROOT/frontend/dist.
# We never rm -rf against INSTALL_ROOT/frontend/dist; instead we stage into
# INSTALL_ROOT/frontend/.dist-staging, then rename the prior dist to
# .dist-prev and .dist-staging to dist, finally removing .dist-prev. This is
# a staged cutover, not an atomic directory swap:
#   - between "mv dist -> .dist-prev" and "mv .dist-staging -> dist" the
#     install tree may briefly lack dist/ at all;
#   - between "mv .dist-staging -> dist" and "rm -rf .dist-prev" both
#     dist/ and .dist-prev/ exist on disk.
# Readers never observe a half-populated dist/, but the rename window is
# real. If the staging copy fails, .dist-staging is removed before returning.
sync_install_tree_frontend() {
    if [ "$INSTALL_ROOT" = "$REPO_ROOT" ]; then
        return 0
    fi
    if [ ! -f frontend/dist/index.html ]; then
        echo "[Nexus] checkout frontend/dist missing; skipping frontend sync" >&2
        return 0
    fi
    local install_frontend="${INSTALL_ROOT}/frontend"
    mkdir -p "$install_frontend"
    local staging="${install_frontend}/.dist-staging"
    rm -rf "$staging"
    mkdir -p "$staging"
    if ! cp -a frontend/dist/. "$staging/"; then
        rm -rf "$staging"
        echo "[Nexus] failed to stage frontend/dist into ${staging}" >&2
        return 1
    fi

    # Replace the previous install-tree dist via staged rename.
    if [ -d "${install_frontend}/dist" ]; then
        local backup_dist="${install_frontend}/.dist-prev"
        rm -rf "$backup_dist"
        mv "${install_frontend}/dist" "$backup_dist"
    fi
    mv "$staging" "${install_frontend}/dist"
    rm -rf "${install_frontend}/.dist-prev"
}

# Restore the install tree frontend/dist from the backup snapshot. Used on
# rollback paths so the install tree goes back to its pre-deploy frontend
# verbatim, instead of being re-synced from checkout.
restore_install_frontend() {
    if [ "$INSTALL_ROOT" = "$REPO_ROOT" ]; then
        return 0
    fi
    local install_frontend="${INSTALL_ROOT}/frontend"
    local backup_dist="${BACKUP_DIR}/install/frontend/dist"
    local staging="${install_frontend}/.dist-staging"
    rm -rf "$staging"
    if [ ! -d "$backup_dist" ]; then
        # No prior install-tree frontend existed; remove dist if present.
        rm -rf "${install_frontend}/dist" "${install_frontend}/.dist-prev"
        return 0
    fi
    mkdir -p "$staging"
    cp -a "${backup_dist}/." "$staging/"
    if [ -d "${install_frontend}/dist" ]; then
        rm -rf "${install_frontend}/.dist-prev"
        mv "${install_frontend}/dist" "${install_frontend}/.dist-prev"
    fi
    mv "$staging" "${install_frontend}/dist"
    rm -rf "${install_frontend}/.dist-prev"
}

install_native_session_cli() {
    local install_binary="${INSTALL_ROOT}/rust-runtime/target/release/nexus-native-session"
    local install_dir="${NEXUS_CLI_INSTALL_DIR:-${HOME}/.local/bin}"
    local cli_link="${install_dir}/nexus-native-session"

    mkdir -p "$install_dir"
    if [ ! -f "$install_binary" ]; then
        echo "[Nexus] expected installed CLI binary at ${install_binary} but it is missing" >&2
        return 1
    fi
    ln -sfn "$install_binary" "$cli_link"
    echo "[Nexus] Installed native session CLI at ${cli_link}"
}

run_restart_helper() {
    bash "$RESTART_HELPER"
}

# Restart the native PTY supervisor when --restart-native-pty was given and
# the service is active. Sets NATIVE_RESTART_DONE=1 so that, if a later
# Nexus restart/healthcheck fails, the rollback path can restart the
# supervisor again to revert its running process to the restored (previous)
# binary.
restart_native_pty_supervisor_if_requested() {
    if [ "$RESTART_NATIVE_PTY" -ne 1 ]; then
        return 0
    fi
    if ! nexus_systemctl is-active --quiet nexus-native-pty.service; then
        echo "[Nexus] --restart-native-pty set but nexus-native-pty.service is not active; skipping restart"
        return 0
    fi
    echo "[Nexus] Restarting native PTY supervisor..."
    nexus_systemctl restart nexus-native-pty.service
    NATIVE_RESTART_DONE=1
    nexus_systemctl status nexus-native-pty.service --no-pager
}

# When NATIVE_RESTART_DONE is set, restart the native supervisor again so
# its live process is back on the restored (previous) binary. Only used
# from the explicit rollback branch — the trap is detached around the call
# so a failure here does not re-enter on_error and recurse.
rollback_native_pty_supervisor() {
    if [ "$NATIVE_RESTART_DONE" -ne 1 ]; then
        return 0
    fi
    echo "[Nexus] Rolling back native PTY supervisor to previous binary..." >&2
    set +e
    set +E
    trap - ERR
    local rc=0
    nexus_systemctl restart nexus-native-pty.service
    rc=$?
    if [ "$rc" -eq 0 ]; then
        nexus_systemctl status nexus-native-pty.service --no-pager
        rc=$?
    fi
    set -e
    set -E
    trap 'on_error' ERR
    if [ "$rc" -ne 0 ]; then
        echo "[Nexus] rollback-native failed with exit ${rc}" >&2
    fi
    return $rc
}

# --- main flow ---------------------------------------------------------------

INSTALL_ROOT="$(resolve_install_root)"
if [ "$INSTALL_ROOT" = "$REPO_ROOT" ]; then
    echo "[Nexus] Install root equals checkout (REPO_ROOT); single-tree mode."
else
    echo "[Nexus] Install root: ${INSTALL_ROOT}"
fi

if [ "$RUN_FRONTEND_BUILD" -eq 1 ]; then
    echo "[Nexus] Building frontend dist..."
    npm --prefix frontend run build
fi

if [ ! -f frontend/dist/index.html ]; then
    echo "[Nexus] Missing frontend/dist/index.html; build frontend before deploying" >&2
    exit 1
fi

echo "[Nexus] Backing up current release binaries and install-tree state to ${BACKUP_DIR}..."
backup_release_bins
RESTORE_NEEDED=1

CARGO_BIN="$(resolve_cargo_bin)"
echo "[Nexus] Building release binaries..."
"$CARGO_BIN" build --manifest-path rust-runtime/Cargo.toml --release \
    --bin nexus-server \
    --bin nexus-pty-runtime \
    --bin nexus-native-pty-supervisor \
    --bin nexus-native-session \
    --bin nexus-window-launch-runtime \
    --bin nexus-session-runtime \
    --bin nexus-codex-home

echo "[Nexus] Syncing release binaries to install tree..."
sync_release_bins_to_install

echo "[Nexus] Syncing vendored frontend/dist to install tree..."
sync_install_tree_frontend

install_native_session_cli

restart_native_pty_supervisor_if_requested
if [ "$RESTART_NATIVE_PTY" -ne 1 ] && nexus_systemctl is-active --quiet nexus-native-pty.service; then
    echo "[Nexus] Native PTY supervisor is running; not restarting it to preserve native sessions."
    echo "[Nexus] Pass --restart-native-pty to restart it explicitly."
fi

echo "[Nexus] Restarting deployed service..."
if run_restart_helper; then
    RESTORE_NEEDED=0
    echo "[Nexus] Deploy complete."
    exit 0
fi

echo "[Nexus] Deploy restart failed; restoring previous release binaries and frontend..." >&2
restore_release_bins
restore_install_frontend
if ! rollback_native_pty_supervisor; then
    echo "[Nexus] rollback-native failed during deploy rollback." >&2
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
