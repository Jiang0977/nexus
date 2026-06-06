#!/bin/bash
# nexus-run-codex.sh — 以隔离 HOME 启动 codex，会话绑定到显式 runtime id 或 tmux window_id
# 用法: nexus-run-codex.sh <profile_id?> <project_absolute_path> <resume_session_id?>

set -euo pipefail

PROFILE="${1:-}"
PROJECT="${2:-}"
RESUME_SESSION_ID="${3:-}"

if [ -z "$PROJECT" ]; then
    echo "[Nexus] Usage: nexus-run-codex.sh <profile?> <project_path> <resume_session_id?>"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/scripts/nexus-paths.sh"
SOURCE_HOME="$(resolve_source_home)"
ensure_codex_cli_on_path "${SOURCE_HOME}"
ensure_rust_toolchain_on_path "${SOURCE_HOME}"
DATA_DIR="${NEXUS_DATA_DIR:-${SCRIPT_DIR}/data}"
if [[ "$DATA_DIR" != /* ]]; then
    DATA_DIR="${SCRIPT_DIR}/${DATA_DIR}"
fi
DEFAULT_CODEX_HOME_EXECUTABLE="${SCRIPT_DIR}/rust-runtime/target/release/nexus-codex-home"
CODEX_HOME_EXECUTABLE="${NEXUS_CODEX_HOME_EXECUTABLE:-$DEFAULT_CODEX_HOME_EXECUTABLE}"
CONFIG_FILE=""
if [ -n "$PROFILE" ]; then
    CONFIG_FILE="${DATA_DIR}/codex-configs/${PROFILE}.json"
    if [ ! -f "$CONFIG_FILE" ]; then
        echo "[Nexus] Codex profile '${PROFILE}' not found at ${CONFIG_FILE}"
        exit 1
    fi
fi

runtime_id="${NEXUS_CODEX_RUNTIME_ID:-${NEXUS_NATIVE_CHANNEL_ID:-}}"
if [ -z "$runtime_id" ]; then
    runtime_id="$(tmux display-message -p '#{window_id}' 2>/dev/null || true)"
fi
if [ -z "$runtime_id" ]; then
    runtime_id="window-$$"
fi
safe_window_id="$(printf '%s' "$runtime_id" | sed 's/[^a-zA-Z0-9._-]/-/g')"
runtime_home="${DATA_DIR}/codex-runtime/${safe_window_id}"

mkdir -p "${DATA_DIR}/codex-runtime"
export NEXUS_SOURCE_HOME="${SOURCE_HOME}"
export NEXUS_CODEX_SOURCE_HOME="${SOURCE_HOME}/.codex"
if [ -z "${NEXUS_CODEX_HOME_EXECUTABLE:-}" ] && [ ! -x "$DEFAULT_CODEX_HOME_EXECUTABLE" ]; then
    echo "[Nexus] 构建 Rust codex home tool..."
    cargo build --manifest-path "${SCRIPT_DIR}/rust-runtime/Cargo.toml" --release --bin nexus-codex-home
fi
if [ ! -x "$CODEX_HOME_EXECUTABLE" ]; then
    echo "[Nexus] Rust codex home tool 不可执行: ${CODEX_HOME_EXECUTABLE}"
    exit 1
fi
HOME="${SOURCE_HOME}" "${CODEX_HOME_EXECUTABLE}" "${CONFIG_FILE}" "${runtime_home}" "${PROJECT}"

source_skills="${SOURCE_HOME}/.codex/skills"
runtime_skills="${runtime_home}/.codex/skills"
if [ -d "$source_skills" ] && [ ! -e "$runtime_skills" ] && [ ! -L "$runtime_skills" ]; then
    ln -s "$source_skills" "$runtime_skills"
elif [ -d "$source_skills" ] && [ -L "$runtime_skills" ] && [ "$(readlink "$runtime_skills")" != "$source_skills" ]; then
    rm -f "$runtime_skills"
    ln -s "$source_skills" "$runtime_skills"
fi

export LANG="C.UTF-8"
export LC_ALL="C.UTF-8"

# 代理变量：优先使用 NEXUS_PROXY（nexus-server 注入），其次继承环境
_proxy="${NEXUS_PROXY:-${HTTP_PROXY:-}}"
if [ -n "$_proxy" ]; then
    export HTTP_PROXY="$_proxy"
    export HTTPS_PROXY="$_proxy"
    export ALL_PROXY="$_proxy"
    export http_proxy="$_proxy"
    export https_proxy="$_proxy"
fi
unset _proxy

CODEX_BIN="$(which -a codex 2>/dev/null | tail -1)"
if [ -z "$CODEX_BIN" ]; then
    CODEX_BIN="codex"
fi

export NEXUS_REPO_ROOT="${SCRIPT_DIR}"
if [ -n "$SOURCE_HOME" ]; then
    export NEXUS_CODEX_SOURCE_HOME="${SOURCE_HOME}/.codex"
fi
export NEXUS_REAL_CODEX_BIN="${CODEX_BIN}"
export PATH="${SCRIPT_DIR}/scripts/runtime-bin:${PATH}"

codex_bin_supplies_bypass() {
    local sample=""
    if [ -z "${CODEX_BIN:-}" ] || [ ! -r "$CODEX_BIN" ]; then
        return 1
    fi
    sample="$(LC_ALL=C head -c 32768 "$CODEX_BIN" 2>/dev/null || true)"
    [[ "$sample" == *"--dangerously-bypass-approvals-and-sandbox"* ]]
}

build_codex_args() {
    CODEX_ARGS=()
    if ! codex_bin_supplies_bypass; then
        CODEX_ARGS+=("--dangerously-bypass-approvals-and-sandbox")
    fi
    CODEX_ARGS+=("$@")
}

label="${PROFILE:-Manual login}"
if [ -n "$CONFIG_FILE" ]; then
    label="$(python3 - "$CONFIG_FILE" <<'PY'
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    data = json.load(fh)
print(data.get('label') or data.get('id') or 'Codex')
PY
)"
fi

cd "$PROJECT"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  Nexus · Codex Session"
echo "║  Profile : ${label}"
echo "║  Project : ${PROJECT}"
echo "║  Runtime : ${safe_window_id}"
echo "╚══════════════════════════════════════════╝"
echo ""

while true; do
    codex_env=(
        HOME="${runtime_home}"
        LANG="C.UTF-8"
        LC_ALL="C.UTF-8"
        NEXUS_SOURCE_HOME="${SOURCE_HOME}"
        NEXUS_CODEX_SOURCE_HOME="${SOURCE_HOME}/.codex"
    )
    if [ -n "$RESUME_SESSION_ID" ]; then
        build_codex_args resume "$RESUME_SESSION_ID" --no-alt-screen
        env "${codex_env[@]}" "$CODEX_BIN" "${CODEX_ARGS[@]}" || true
    else
        build_codex_args --no-alt-screen
        env "${codex_env[@]}" "$CODEX_BIN" "${CODEX_ARGS[@]}" || true
    fi
    echo ""
    echo "[Nexus] Codex exited.  r=restart  b=bash shell  q=quit window"
    read -r REPLY
    case "$REPLY" in
        b) exec bash -i ;;
        q) break ;;
    esac
done

echo "[Nexus] Session ended."
exec bash -i
