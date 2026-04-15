#!/bin/bash
# nexus-run-codex.sh — 以隔离 HOME 启动 codex，会话绑定到 tmux window_id
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
CONFIG_FILE=""
if [ -n "$PROFILE" ]; then
    CONFIG_FILE="${SCRIPT_DIR}/data/codex-configs/${PROFILE}.json"
    if [ ! -f "$CONFIG_FILE" ]; then
        echo "[Nexus] Codex profile '${PROFILE}' not found at ${CONFIG_FILE}"
        exit 1
    fi
fi

window_id="$(tmux display-message -p '#{window_id}' 2>/dev/null || true)"
if [ -z "$window_id" ]; then
    window_id="window-$$"
fi
safe_window_id="$(printf '%s' "$window_id" | sed 's/[^a-zA-Z0-9._-]/-/g')"
runtime_home="${SCRIPT_DIR}/data/codex-runtime/${safe_window_id}"

mkdir -p "${SCRIPT_DIR}/data/codex-runtime"
node "${SCRIPT_DIR}/scripts/materialize-codex-home.mjs" "${CONFIG_FILE}" "${runtime_home}" "${PROJECT}"

export HOME="${runtime_home}"
export LANG="C.UTF-8"
export LC_ALL="C.UTF-8"

# 代理变量：优先使用 NEXUS_PROXY（server.js 注入），其次继承环境
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
    if [ -n "$RESUME_SESSION_ID" ]; then
        "$CODEX_BIN" resume "$RESUME_SESSION_ID" --dangerously-bypass-approvals-and-sandbox --no-alt-screen || true
    else
        "$CODEX_BIN" --dangerously-bypass-approvals-and-sandbox --no-alt-screen || true
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
