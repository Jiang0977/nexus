#!/usr/bin/env bash

prepend_path_dir() {
  local dir="$1"
  [[ -n "$dir" && -d "$dir" ]] || return 0

  case ":${PATH:-}:" in
    *":$dir:"*) ;;
    *) export PATH="$dir${PATH:+:$PATH}" ;;
  esac
}

find_codex_bin_dir() {
  local home_dir="${HOME:-}"
  local candidate=""
  local nvm_root=""

  if [[ -n "${NEXUS_CODEX_EXECUTABLE:-}" && -x "${NEXUS_CODEX_EXECUTABLE:-}" ]]; then
    dirname "${NEXUS_CODEX_EXECUTABLE}"
    return 0
  fi

  for candidate in \
    "$home_dir/.volta/bin/codex" \
    "$home_dir/.npm/bin/codex"
  do
    if [[ -x "$candidate" ]]; then
      dirname "$candidate"
      return 0
    fi
  done

  nvm_root="$home_dir/.nvm/versions/node"
  if [[ -d "$nvm_root" ]]; then
    candidate="$(find "$nvm_root" -mindepth 3 -maxdepth 3 \( -type f -o -type l \) -path '*/bin/codex' 2>/dev/null | sort -V -r | head -n 1)"
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      dirname "$candidate"
      return 0
    fi
  fi

  return 1
}

ensure_codex_cli_on_path() {
  if codex --version >/dev/null 2>&1; then
    return 0
  fi

  local codex_bin_dir=""
  codex_bin_dir="$(find_codex_bin_dir || true)"
  [[ -n "$codex_bin_dir" ]] || return 0
  prepend_path_dir "$codex_bin_dir"
}
