#!/bin/bash
# nexus-run-claude.sh — 以指定配置 profile 启动 claude
# 用法: nexus-run-claude.sh <profile_id> <project_absolute_path>

set -e

PROFILE="$1"
PROJECT="$2"

if [ -z "$PROFILE" ] || [ -z "$PROJECT" ]; then
    echo "[Nexus] Usage: nexus-run-claude.sh <profile> <project_path>"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/scripts/nexus-paths.sh"
SOURCE_HOME="$(resolve_source_home)"
ensure_rust_toolchain_on_path "${SOURCE_HOME}"
CONFIG_FILE="${SCRIPT_DIR}/data/configs/${PROFILE}.json"
if [ ! -f "$CONFIG_FILE" ]; then
    echo "[Nexus] Config profile '${PROFILE}' not found at ${CONFIG_FILE}"
    exit 1
fi

# 用 python3 读取 JSON 配置（python3 已在 cc:nexus 中安装）
cfg() {
    python3 -c "import json; d=json.load(open('${CONFIG_FILE}')); print(d.get('$1',''))"
}

materialize_claude_runtime_settings() {
    local source_home="$1"
    local runtime_root="$2"
    local window_id=""
    local safe_window_id=""
    local runtime_dir=""
    local settings_path=""

    if [ -z "$source_home" ]; then
        return 0
    fi

    window_id="$(tmux display-message -p '#{window_id}' 2>/dev/null || true)"
    if [ -z "$window_id" ]; then
        window_id="window-$$"
    fi
    safe_window_id="$(printf '%s' "$window_id" | sed 's/[^a-zA-Z0-9._-]/-/g')"
    runtime_dir="${runtime_root}/${safe_window_id}"
    settings_path="${runtime_dir}/settings.json"

    mkdir -p "$runtime_dir"

    NEXUS_PROFILE_BASE_URL="$BASE_URL" \
    NEXUS_PROFILE_AUTH_TOKEN="$AUTH_TOKEN" \
    NEXUS_PROFILE_API_KEY="$API_KEY" \
    NEXUS_PROFILE_DEFAULT_MODEL="$DEFAULT_MODEL" \
    NEXUS_PROFILE_DEFAULT_HAIKU_MODEL="$DEFAULT_HAIKU_MODEL" \
    NEXUS_PROFILE_THINK_MODEL="$THINK_MODEL" \
    NEXUS_PROFILE_LONG_CONTEXT_MODEL="$LONG_CONTEXT_MODEL" \
    NEXUS_PROFILE_API_TIMEOUT_MS="$API_TIMEOUT_MS" \
    python3 - "$source_home" "$settings_path" <<'PY'
import json
import os
import pathlib
import sys

source_home, settings_path = sys.argv[1:3]
source_claude_dir = pathlib.Path(source_home) / ".claude"
source_settings = source_claude_dir / "settings.json"
target_settings = pathlib.Path(settings_path)
safe_setting_keys = (
    "enabledPlugins",
    "extraKnownMarketplaces",
    "hooks",
)
profile_env = {
    "ANTHROPIC_BASE_URL": os.environ.get("NEXUS_PROFILE_BASE_URL", ""),
    "ANTHROPIC_AUTH_TOKEN": os.environ.get("NEXUS_PROFILE_AUTH_TOKEN", ""),
    "ANTHROPIC_API_KEY": os.environ.get("NEXUS_PROFILE_API_KEY", ""),
    "ANTHROPIC_MODEL": os.environ.get("NEXUS_PROFILE_DEFAULT_MODEL", ""),
    "ANTHROPIC_SMALL_FAST_MODEL": os.environ.get("NEXUS_PROFILE_DEFAULT_MODEL", ""),
    "ANTHROPIC_DEFAULT_SONNET_MODEL": os.environ.get("NEXUS_PROFILE_DEFAULT_MODEL", ""),
    "ANTHROPIC_DEFAULT_OPUS_MODEL": os.environ.get("NEXUS_PROFILE_DEFAULT_MODEL", ""),
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": os.environ.get("NEXUS_PROFILE_DEFAULT_HAIKU_MODEL", ""),
    "ANTHROPIC_THINK_MODEL": os.environ.get("NEXUS_PROFILE_THINK_MODEL", ""),
    "ANTHROPIC_LONG_CONTEXT_MODEL": os.environ.get("NEXUS_PROFILE_LONG_CONTEXT_MODEL", ""),
    "API_TIMEOUT_MS": os.environ.get("NEXUS_PROFILE_API_TIMEOUT_MS", ""),
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
}

try:
    data = json.loads(source_settings.read_text(encoding="utf-8"))
except FileNotFoundError:
    data = {}
except Exception as error:
    print(f"[Nexus] Warning: failed to parse {source_settings}: {error}", file=sys.stderr)
    data = {}

sanitized_settings = {
    key: data[key]
    for key in safe_setting_keys
    if data.get(key)
}
sanitized_settings["env"] = profile_env
target_settings.write_text(
    json.dumps(sanitized_settings, ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8",
)
print(target_settings)
PY
}

BASE_URL=$(cfg BASE_URL)
AUTH_TOKEN=$(cfg AUTH_TOKEN)
API_KEY=$(cfg API_KEY)
DEFAULT_MODEL=$(cfg DEFAULT_MODEL)
THINK_MODEL=$(cfg THINK_MODEL)
LONG_CONTEXT_MODEL=$(cfg LONG_CONTEXT_MODEL)
DEFAULT_HAIKU_MODEL=$(cfg DEFAULT_HAIKU_MODEL)
API_TIMEOUT_MS=$(cfg API_TIMEOUT_MS)
LABEL=$(cfg label)

# ── 导出所有环境变量 ──
export LANG="C.UTF-8"
export LC_ALL="C.UTF-8"
export HOME="${SOURCE_HOME}"

# 仅当配置项非空时才设置（使用官方 API 时这些可以为空）
if [ -n "$BASE_URL" ]; then
    export ANTHROPIC_BASE_URL="$BASE_URL"
fi
if [ -n "$AUTH_TOKEN" ]; then
    export ANTHROPIC_AUTH_TOKEN="$AUTH_TOKEN"
fi
if [ -n "$API_KEY" ]; then
    export ANTHROPIC_API_KEY="$API_KEY"
fi
if [ -n "$DEFAULT_MODEL" ]; then
    export ANTHROPIC_MODEL="$DEFAULT_MODEL"
    export ANTHROPIC_SMALL_FAST_MODEL="$DEFAULT_MODEL"
    export ANTHROPIC_DEFAULT_SONNET_MODEL="$DEFAULT_MODEL"
    export ANTHROPIC_DEFAULT_OPUS_MODEL="$DEFAULT_MODEL"
fi
if [ -n "$DEFAULT_HAIKU_MODEL" ]; then
    export ANTHROPIC_DEFAULT_HAIKU_MODEL="$DEFAULT_HAIKU_MODEL"
fi
if [ -n "$THINK_MODEL" ]; then
    export ANTHROPIC_THINK_MODEL="$THINK_MODEL"
fi
if [ -n "$LONG_CONTEXT_MODEL" ]; then
    export ANTHROPIC_LONG_CONTEXT_MODEL="$LONG_CONTEXT_MODEL"
fi
if [ -n "$API_TIMEOUT_MS" ]; then
    export API_TIMEOUT_MS="$API_TIMEOUT_MS"
fi
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

# ── 代理变量：优先使用 NEXUS_PROXY（nexus-server 注入），其次继承环境 ──
_proxy="${NEXUS_PROXY:-${HTTP_PROXY:-}}"
if [ -n "$_proxy" ]; then
    export HTTP_PROXY="$_proxy"
    export HTTPS_PROXY="$_proxy"
    export ALL_PROXY="$_proxy"
    export http_proxy="$_proxy"
    export https_proxy="$_proxy"
fi
unset _proxy

cd "$PROJECT"

declare -a CLAUDE_LAUNCH_ARGS
CLAUDE_LAUNCH_ARGS=(--dangerously-skip-permissions)
CLAUDE_RUNTIME_ROOT="${NEXUS_CLAUDE_RUNTIME_DIR:-${SCRIPT_DIR}/data/claude-runtime}"
CLAUDE_RUNTIME_SETTINGS_FILE="$(materialize_claude_runtime_settings "$SOURCE_HOME" "$CLAUDE_RUNTIME_ROOT" || true)"
if [ -n "$CLAUDE_RUNTIME_SETTINGS_FILE" ]; then
    CLAUDE_LAUNCH_ARGS+=(--settings "$CLAUDE_RUNTIME_SETTINGS_FILE")
fi

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  Nexus · Claude Session"
echo "║  Profile : ${LABEL:-$PROFILE}"
echo "║  Project : $PROJECT"
if [ -z "$BASE_URL" ]; then
    echo "║  API     : Anthropic (官方)"
elif [[ "$BASE_URL" == *"kimi"* ]]; then
    echo "║  API     : Kimi"
elif [[ "$BASE_URL" == *"openrouter"* ]]; then
    echo "║  API     : OpenRouter"
else
    echo "║  API     : 自定义"
fi
echo "╚══════════════════════════════════════════╝"
echo ""

# ── 主循环：退出后提示续接 ──
while true; do
    claude "${CLAUDE_LAUNCH_ARGS[@]}" || true
    echo ""
    echo "[Nexus] Claude exited.  r=restart  b=bash shell  q=quit window"
    read -r REPLY
    case "$REPLY" in
        b) exec bash -i ;;
        q) break ;;
    esac
done

echo "[Nexus] Session ended."
# 退出后启动 bash 保持窗口打开（防止用户意外关闭窗口）
exec bash -i
