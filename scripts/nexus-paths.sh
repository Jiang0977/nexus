#!/usr/bin/env bash

prepend_path_dir() {
  local dir="$1"
  [[ -n "$dir" && -d "$dir" ]] || return 0

  case ":${PATH:-}:" in
    *":$dir:"*) ;;
    *) export PATH="$dir${PATH:+:$PATH}" ;;
  esac
}

prefer_path_dir() {
  local dir="$1"
  local segment=""
  local reordered=""
  [[ -n "$dir" && -d "$dir" ]] || return 0

  IFS=':' read -r -a __nexus_path_segments <<< "${PATH:-}"
  for segment in "${__nexus_path_segments[@]}"; do
    [[ -n "$segment" && "$segment" != "$dir" ]] || continue
    if [[ -n "$reordered" ]]; then
      reordered="${reordered}:$segment"
    else
      reordered="$segment"
    fi
  done

  export PATH="$dir${reordered:+:$reordered}"
}

resolve_source_home() {
  local override="${NEXUS_SOURCE_HOME:-}"
  local user_name="${USER:-${LOGNAME:-}}"
  local resolved_home="${HOME:-}"
  local passwd_home=""

  if [[ -n "$override" && -d "$override" ]]; then
    printf '%s\n' "$override"
    return 0
  fi

  if [[ -n "$user_name" ]] && command -v getent >/dev/null 2>&1; then
    passwd_home="$(getent passwd "$user_name" 2>/dev/null | awk -F: 'NR == 1 { print $6 }')"
    if [[ -n "$passwd_home" && -d "$passwd_home" ]]; then
      printf '%s\n' "$passwd_home"
      return 0
    fi
  fi

  if command -v python3 >/dev/null 2>&1; then
    passwd_home="$(python3 - <<'PY'
import os
import pwd

try:
    print(pwd.getpwuid(os.getuid()).pw_dir)
except Exception:
    pass
PY
)"
    if [[ -n "$passwd_home" && -d "$passwd_home" ]]; then
      printf '%s\n' "$passwd_home"
      return 0
    fi
  fi

  printf '%s\n' "$resolved_home"
}

find_codex_bin_dir() {
  local home_dir="${1:-${HOME:-}}"
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
  local source_home="${1:-${HOME:-}}"
  local local_bin_dir="${source_home}/.local/bin"

  local codex_bin_dir=""
  codex_bin_dir="$(find_codex_bin_dir "$source_home" || true)"
  if [[ -n "$codex_bin_dir" ]]; then
    prepend_path_dir "$codex_bin_dir"
  fi
  prefer_path_dir "$local_bin_dir"
}

ensure_rust_toolchain_on_path() {
  local source_home="${1:-${HOME:-}}"
  local cargo_home="${CARGO_HOME:-}"
  local rustup_home="${RUSTUP_HOME:-}"
  local cargo_bin_dir=""

  if [[ -z "$cargo_home" && -n "$source_home" ]]; then
    cargo_home="${source_home}/.cargo"
  fi
  if [[ -z "$rustup_home" && -n "$source_home" ]]; then
    rustup_home="${source_home}/.rustup"
  fi
  if [[ -z "$cargo_home" ]]; then
    return 0
  fi

  cargo_bin_dir="${cargo_home}/bin"
  if [[ -d "$cargo_bin_dir" ]]; then
    prepend_path_dir "$cargo_bin_dir"
    export CARGO_HOME="$cargo_home"
  fi

  if [[ -n "$rustup_home" && -d "$rustup_home" ]]; then
    export RUSTUP_HOME="$rustup_home"
  fi
}
