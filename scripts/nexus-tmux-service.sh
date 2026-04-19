#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
DEFAULT_SHELL_COMMAND='exec zsh -i'

read_env_var() {
  local key="$1"
  if [[ ! -f "$ENV_FILE" ]]; then
    return 0
  fi

  sed -n "s/^${key}=//p" "$ENV_FILE" | head -n 1 | tr -d '\r'
}

TMUX_SESSION_NAME="$(read_env_var TMUX_SESSION)"
TMUX_SESSION_NAME="${TMUX_SESSION_NAME:-main}"

start_tmux_server() {
  if ! tmux has-session -t "$TMUX_SESSION_NAME" 2>/dev/null; then
    tmux new-session -d -s "$TMUX_SESSION_NAME" -n shell "$DEFAULT_SHELL_COMMAND"
  fi
}

stop_tmux_server() {
  if tmux has-session -t "$TMUX_SESSION_NAME" 2>/dev/null; then
    tmux kill-server
  fi
}

case "${1:-}" in
  start)
    start_tmux_server
    ;;
  stop)
    stop_tmux_server
    ;;
  pid)
    tmux display-message -t "$TMUX_SESSION_NAME" -p '#{pid}'
    ;;
  *)
    echo "usage: $0 {start|stop|pid}" >&2
    exit 2
    ;;
esac
