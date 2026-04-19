#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
DEFAULT_SHELL_COMMAND='exec zsh -i'

source "$SCRIPT_DIR/nexus-paths.sh"
ensure_codex_cli_on_path

read_env_var() {
  local key="$1"
  if [[ ! -f "$ENV_FILE" ]]; then
    return 0
  fi

  sed -n "s/^${key}=//p" "$ENV_FILE" | head -n 1 | tr -d '\r'
}

TMUX_SESSION_NAME="$(read_env_var TMUX_SESSION)"
TMUX_SESSION_NAME="${TMUX_SESSION_NAME:-main}"

ensure_tmux_session() {
  local attempt
  for attempt in $(seq 1 50); do
    if tmux -N new-session -Ad -s "$TMUX_SESSION_NAME" -n shell "$DEFAULT_SHELL_COMMAND" 2>/dev/null; then
      return 0
    fi
    sleep 0.1
  done

  echo "failed to initialize tmux session: $TMUX_SESSION_NAME" >&2
  return 1
}

start_tmux_server() {
  if ! tmux has-session -t "$TMUX_SESSION_NAME" 2>/dev/null; then
    tmux new-session -Ad -s "$TMUX_SESSION_NAME" -n shell "$DEFAULT_SHELL_COMMAND"
  fi
}

start_tmux_server_foreground() {
  exec tmux -D
}

stop_tmux_server() {
  if tmux -N kill-server 2>/dev/null; then
    return 0
  fi

  return 0
}

case "${1:-}" in
  start)
    start_tmux_server
    ;;
  start-foreground)
    start_tmux_server_foreground
    ;;
  ensure-session)
    ensure_tmux_session
    ;;
  stop)
    stop_tmux_server
    ;;
  pid)
    tmux -N display-message -t "$TMUX_SESSION_NAME" -p '#{pid}'
    ;;
  *)
    echo "usage: $0 {start|start-foreground|ensure-session|stop|pid}" >&2
    exit 2
    ;;
esac
