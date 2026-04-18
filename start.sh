#!/bin/bash
# Nexus 启动脚本
# 在宿主机（WSL2）上直接运行: bash start.sh
# 或: PORT=59000 bash start.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 检查 .env 文件
if [ ! -f .env ]; then
    echo "错误: .env 文件不存在"
    echo "请复制 .env.example 并填写配置: cp .env.example .env"
    exit 1
fi

# 检查 node_modules
if [ ! -d node_modules ]; then
    echo "安装依赖..."
    npm install
fi

# 检查前端构建
if [ ! -d frontend/dist ]; then
    echo "构建前端..."
    cd frontend && npm install && npm run build && cd ..
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

SERVER_EXECUTABLE="$(resolve_env_or_file NEXUS_SERVER_EXECUTABLE)"
TASK_RUNNER_RUST_EXECUTABLE="$(resolve_env_or_file NEXUS_TASK_RUNNER_RUST_EXECUTABLE)"
PTY_BROKER_RUST_EXECUTABLE="$(resolve_env_or_file NEXUS_PTY_BROKER_RUST_EXECUTABLE)"
WINDOW_LAUNCH_RUST_EXECUTABLE="$(resolve_env_or_file NEXUS_WINDOW_LAUNCH_RUST_EXECUTABLE)"
SESSION_MANAGEMENT_RUST_EXECUTABLE="$(resolve_env_or_file NEXUS_SESSION_MANAGEMENT_RUST_EXECUTABLE)"
DEFAULT_TASK_RUNTIME="$SCRIPT_DIR/rust-runtime/target/release/nexus-task-runtime"
DEFAULT_PTY_RUNTIME="$SCRIPT_DIR/rust-runtime/target/release/nexus-pty-runtime"
DEFAULT_WINDOW_LAUNCH_RUNTIME="$SCRIPT_DIR/rust-runtime/target/release/nexus-window-launch-runtime"
DEFAULT_SESSION_MANAGEMENT_RUNTIME="$SCRIPT_DIR/rust-runtime/target/release/nexus-session-runtime"
DEFAULT_RUST_SERVER_EXECUTABLE="$SCRIPT_DIR/rust-runtime/target/release/nexus-server"
NEED_TASK_RUNTIME=0
NEED_PTY_RUNTIME=0
NEED_WINDOW_LAUNCH_RUNTIME=0
NEED_SESSION_MANAGEMENT_RUNTIME=0
NEED_RUST_SERVER=0

if [ -z "$SERVER_EXECUTABLE" ]; then
    SERVER_EXECUTABLE="$DEFAULT_RUST_SERVER_EXECUTABLE"
fi

if [ -n "$SERVER_EXECUTABLE" ]; then
    if [ -z "$TASK_RUNNER_RUST_EXECUTABLE" ]; then
        TASK_RUNNER_RUST_EXECUTABLE="$DEFAULT_TASK_RUNTIME"
        if [ ! -x "$DEFAULT_TASK_RUNTIME" ]; then
            NEED_TASK_RUNTIME=1
        fi
    fi

    if [ -z "$PTY_BROKER_RUST_EXECUTABLE" ]; then
        PTY_BROKER_RUST_EXECUTABLE="$DEFAULT_PTY_RUNTIME"
        if [ ! -x "$DEFAULT_PTY_RUNTIME" ]; then
            NEED_PTY_RUNTIME=1
        fi
    fi

    if [ -z "$WINDOW_LAUNCH_RUST_EXECUTABLE" ]; then
        WINDOW_LAUNCH_RUST_EXECUTABLE="$DEFAULT_WINDOW_LAUNCH_RUNTIME"
        if [ ! -x "$DEFAULT_WINDOW_LAUNCH_RUNTIME" ]; then
            NEED_WINDOW_LAUNCH_RUNTIME=1
        fi
    fi

    if [ -z "$SESSION_MANAGEMENT_RUST_EXECUTABLE" ]; then
        SESSION_MANAGEMENT_RUST_EXECUTABLE="$DEFAULT_SESSION_MANAGEMENT_RUNTIME"
        if [ ! -x "$DEFAULT_SESSION_MANAGEMENT_RUNTIME" ]; then
            NEED_SESSION_MANAGEMENT_RUNTIME=1
        fi
    fi
fi

if [ -n "$SERVER_EXECUTABLE" ] && [ "$SERVER_EXECUTABLE" = "$DEFAULT_RUST_SERVER_EXECUTABLE" ] && [ ! -x "$DEFAULT_RUST_SERVER_EXECUTABLE" ]; then
    NEED_RUST_SERVER=1
fi

NEED_RUST_RUNTIME_COUNT=$((NEED_TASK_RUNTIME + NEED_PTY_RUNTIME + NEED_WINDOW_LAUNCH_RUNTIME + NEED_SESSION_MANAGEMENT_RUNTIME))

if [ "$NEED_RUST_RUNTIME_COUNT" -gt 1 ]; then
    echo "构建 Rust runtimes..."
    npm run build:rust-runtimes
elif [ "$NEED_TASK_RUNTIME" -eq 1 ]; then
    echo "构建 Rust task runtime..."
    npm run build:rust-task-runtime
elif [ "$NEED_PTY_RUNTIME" -eq 1 ]; then
    echo "构建 Rust pty runtime..."
    npm run build:rust-pty-runtime
elif [ "$NEED_WINDOW_LAUNCH_RUNTIME" -eq 1 ]; then
    echo "构建 Rust window launch runtime..."
    npm run build:rust-launch-runtime
elif [ "$NEED_SESSION_MANAGEMENT_RUNTIME" -eq 1 ]; then
    echo "构建 Rust session management runtime..."
    npm run build:rust-session-runtime
fi

if [ "$NEED_RUST_SERVER" -eq 1 ]; then
    echo "构建 Rust server..."
    npm run build:rust-server
fi

if [ -n "$SERVER_EXECUTABLE" ] && [ ! -x "$SERVER_EXECUTABLE" ]; then
    echo "错误: NEXUS_SERVER_EXECUTABLE 不可执行: $SERVER_EXECUTABLE"
    exit 1
fi

# Rust server 会自行读取 .env。
# 这里不再 source，避免 bcrypt hash 等包含 `$` 的值被 shell 展开破坏。
export PORT="${PORT:-59000}"

export NEXUS_TASK_RUNNER_RUST_EXECUTABLE="$TASK_RUNNER_RUST_EXECUTABLE"
export NEXUS_PTY_BROKER_RUST_EXECUTABLE="$PTY_BROKER_RUST_EXECUTABLE"
export NEXUS_WINDOW_LAUNCH_RUST_EXECUTABLE="$WINDOW_LAUNCH_RUST_EXECUTABLE"
export NEXUS_SESSION_MANAGEMENT_RUST_EXECUTABLE="$SESSION_MANAGEMENT_RUST_EXECUTABLE"
echo "启动 Nexus Rust server on :$PORT ..."
exec "$SERVER_EXECUTABLE"
