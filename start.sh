#!/bin/bash
# Nexus 启动脚本
# 在宿主机（WSL2）上直接运行: bash start.sh
# 或: PORT=59000 bash start.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

source "$SCRIPT_DIR/scripts/nexus-paths.sh"
ensure_codex_cli_on_path

# 检查 .env 文件
if [ ! -f .env ]; then
    echo "错误: .env 文件不存在"
    echo "请复制 .env.example 并填写配置: cp .env.example .env"
    exit 1
fi

# 检查前端静态资源
if [ ! -f frontend/dist/index.html ]; then
    echo "错误: 缺少 vendored 前端资源 frontend/dist/index.html"
    echo "运行时仍直接伺服 frontend/dist；如果你改了 frontend/src，请先在 frontend/ 下执行 npm install && npm run build。"
    exit 1
fi

read_env_value() {
    local key="$1"
    local line
    line=$(grep -E "^${key}=" .env | tail -n 1 || true)
    if [ -n "$line" ]; then
        printf '%s' "${line#*=}" | tr -d '\r'
    fi
}

resolve_env_or_file() {
    local key="$1"
    local current="${!key:-}"
    if [ -n "$current" ]; then
        printf '%s' "$current"
        return
    fi
    read_env_value "$key"
}

build_rust_release_bins() {
    local cargo_bin
    cargo_bin="$(resolve_cargo_bin)"
    "$cargo_bin" build --manifest-path rust-runtime/Cargo.toml --release "$@"
}

resolve_cargo_bin() {
    if command -v cargo >/dev/null 2>&1; then
        command -v cargo
        return 0
    fi

    local cargo_home_bin="${CARGO_HOME:-${HOME:-$SCRIPT_DIR}/.cargo}/bin/cargo"
    if [ -x "$cargo_home_bin" ]; then
        printf '%s\n' "$cargo_home_bin"
        return 0
    fi

    echo "错误: 未找到 cargo；请安装 Rust toolchain 或确保 PATH / HOME/.cargo/bin 可用" >&2
    return 127
}

rust_build_inputs_newer_than() {
    local binary="$1"
    local depfile
    local path

    if [ ! -e "$binary" ]; then
        return 0
    fi

    for path in rust-runtime/Cargo.toml rust-runtime/Cargo.lock; do
        if [ -e "$path" ] && [ "$path" -nt "$binary" ]; then
            return 0
        fi
    done

    depfile="${binary}.d"
    if [ -f "$depfile" ]; then
        while IFS= read -r path; do
            if [ -e "$path" ] && [ "$path" -nt "$binary" ]; then
                return 0
            fi
        done < <(sed -e 's/^[^:]*: //' -e 's/\\$//' "$depfile" | tr ' ' '\n')

        return 1
    fi

    while IFS= read -r path; do
        if [ "$path" -nt "$binary" ]; then
            return 0
        fi
    done < <(find rust-runtime/src -type f 2>/dev/null)

    return 1
}

mark_default_bin_rebuild_if_needed() {
    local binary="$1"
    local flag_name="$2"

    if [ ! -x "$binary" ] || rust_build_inputs_newer_than "$binary"; then
        printf -v "$flag_name" '%s' 1
    fi
}

SERVER_EXECUTABLE="$(resolve_env_or_file NEXUS_SERVER_EXECUTABLE)"
PTY_BROKER_RUST_EXECUTABLE="$(resolve_env_or_file NEXUS_PTY_BROKER_RUST_EXECUTABLE)"
WINDOW_LAUNCH_RUST_EXECUTABLE="$(resolve_env_or_file NEXUS_WINDOW_LAUNCH_RUST_EXECUTABLE)"
SESSION_MANAGEMENT_RUST_EXECUTABLE="$(resolve_env_or_file NEXUS_SESSION_MANAGEMENT_RUST_EXECUTABLE)"
SESSION_BACKEND="$(resolve_env_or_file NEXUS_SESSION_BACKEND | tr '[:upper:]' '[:lower:]')"
DEFAULT_PTY_RUNTIME="$SCRIPT_DIR/rust-runtime/target/release/nexus-pty-runtime"
DEFAULT_NATIVE_PTY_SUPERVISOR="$SCRIPT_DIR/rust-runtime/target/release/nexus-native-pty-supervisor"
DEFAULT_NATIVE_SESSION_CLI="$SCRIPT_DIR/rust-runtime/target/release/nexus-native-session"
DEFAULT_WINDOW_LAUNCH_RUNTIME="$SCRIPT_DIR/rust-runtime/target/release/nexus-window-launch-runtime"
DEFAULT_SESSION_MANAGEMENT_RUNTIME="$SCRIPT_DIR/rust-runtime/target/release/nexus-session-runtime"
DEFAULT_CODEX_HOME_RUNTIME="$SCRIPT_DIR/rust-runtime/target/release/nexus-codex-home"
DEFAULT_RUST_SERVER_EXECUTABLE="$SCRIPT_DIR/rust-runtime/target/release/nexus-server"
NEED_PTY_RUNTIME=0
NEED_NATIVE_PTY_SUPERVISOR=0
NEED_NATIVE_SESSION_CLI=0
NEED_WINDOW_LAUNCH_RUNTIME=0
NEED_SESSION_MANAGEMENT_RUNTIME=0
NEED_CODEX_HOME_RUNTIME=0
NEED_RUST_SERVER=0

if [ -z "$SERVER_EXECUTABLE" ]; then
    SERVER_EXECUTABLE="$DEFAULT_RUST_SERVER_EXECUTABLE"
fi

if [ -n "$SERVER_EXECUTABLE" ]; then
    if [ -z "$PTY_BROKER_RUST_EXECUTABLE" ]; then
        PTY_BROKER_RUST_EXECUTABLE="$DEFAULT_PTY_RUNTIME"
        mark_default_bin_rebuild_if_needed "$DEFAULT_PTY_RUNTIME" NEED_PTY_RUNTIME
    fi

    if [ "$SESSION_BACKEND" = "native" ]; then
        mark_default_bin_rebuild_if_needed "$DEFAULT_NATIVE_PTY_SUPERVISOR" NEED_NATIVE_PTY_SUPERVISOR
        mark_default_bin_rebuild_if_needed "$DEFAULT_NATIVE_SESSION_CLI" NEED_NATIVE_SESSION_CLI
    fi

    if [ -z "$WINDOW_LAUNCH_RUST_EXECUTABLE" ]; then
        WINDOW_LAUNCH_RUST_EXECUTABLE="$DEFAULT_WINDOW_LAUNCH_RUNTIME"
        mark_default_bin_rebuild_if_needed "$DEFAULT_WINDOW_LAUNCH_RUNTIME" NEED_WINDOW_LAUNCH_RUNTIME
    fi

    if [ -z "$SESSION_MANAGEMENT_RUST_EXECUTABLE" ]; then
        SESSION_MANAGEMENT_RUST_EXECUTABLE="$DEFAULT_SESSION_MANAGEMENT_RUNTIME"
        mark_default_bin_rebuild_if_needed "$DEFAULT_SESSION_MANAGEMENT_RUNTIME" NEED_SESSION_MANAGEMENT_RUNTIME
    fi

    if [ -z "${NEXUS_CODEX_HOME_EXECUTABLE:-}" ]; then
        mark_default_bin_rebuild_if_needed "$DEFAULT_CODEX_HOME_RUNTIME" NEED_CODEX_HOME_RUNTIME
    fi
fi

if [ -n "$SERVER_EXECUTABLE" ] && [ "$SERVER_EXECUTABLE" = "$DEFAULT_RUST_SERVER_EXECUTABLE" ]; then
    mark_default_bin_rebuild_if_needed "$DEFAULT_RUST_SERVER_EXECUTABLE" NEED_RUST_SERVER
fi

NEED_RUST_RUNTIME_COUNT=$((NEED_PTY_RUNTIME + NEED_NATIVE_PTY_SUPERVISOR + NEED_NATIVE_SESSION_CLI + NEED_WINDOW_LAUNCH_RUNTIME + NEED_SESSION_MANAGEMENT_RUNTIME + NEED_CODEX_HOME_RUNTIME))

if [ "$NEED_RUST_RUNTIME_COUNT" -gt 1 ]; then
    echo "构建 Rust runtimes..."
    build_rust_release_bins --bin nexus-pty-runtime --bin nexus-native-pty-supervisor --bin nexus-native-session --bin nexus-window-launch-runtime --bin nexus-session-runtime --bin nexus-codex-home
elif [ "$NEED_PTY_RUNTIME" -eq 1 ]; then
    echo "构建 Rust pty runtime..."
    build_rust_release_bins --bin nexus-pty-runtime
elif [ "$NEED_NATIVE_PTY_SUPERVISOR" -eq 1 ]; then
    echo "构建 Rust native pty supervisor..."
    build_rust_release_bins --bin nexus-native-pty-supervisor
elif [ "$NEED_NATIVE_SESSION_CLI" -eq 1 ]; then
    echo "构建 Rust native session cli..."
    build_rust_release_bins --bin nexus-native-session
elif [ "$NEED_WINDOW_LAUNCH_RUNTIME" -eq 1 ]; then
    echo "构建 Rust window launch runtime..."
    build_rust_release_bins --bin nexus-window-launch-runtime
elif [ "$NEED_SESSION_MANAGEMENT_RUNTIME" -eq 1 ]; then
    echo "构建 Rust session management runtime..."
    build_rust_release_bins --bin nexus-session-runtime
elif [ "$NEED_CODEX_HOME_RUNTIME" -eq 1 ]; then
    echo "构建 Rust codex home runtime..."
    build_rust_release_bins --bin nexus-codex-home
fi

if [ "$NEED_RUST_SERVER" -eq 1 ]; then
    echo "构建 Rust server..."
    build_rust_release_bins --bin nexus-server
fi

if [ -n "$SERVER_EXECUTABLE" ] && [ ! -x "$SERVER_EXECUTABLE" ]; then
    echo "错误: NEXUS_SERVER_EXECUTABLE 不可执行: $SERVER_EXECUTABLE"
    exit 1
fi

# Rust server 会自行读取 .env。
# 这里不再 source，避免 bcrypt hash 等包含 `$` 的值被 shell 展开破坏。
export PORT="${PORT:-59000}"

export NEXUS_PTY_BROKER_RUST_EXECUTABLE="$PTY_BROKER_RUST_EXECUTABLE"
export NEXUS_WINDOW_LAUNCH_RUST_EXECUTABLE="$WINDOW_LAUNCH_RUST_EXECUTABLE"
export NEXUS_SESSION_MANAGEMENT_RUST_EXECUTABLE="$SESSION_MANAGEMENT_RUST_EXECUTABLE"
echo "启动 Nexus Rust server on :$PORT ..."
exec "$SERVER_EXECUTABLE"
