#!/usr/bin/env bash

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)/nexus-paths.sh"

nexus_runtime_source_home() {
  resolve_source_home
}

nexus_runtime_resolve_real_command() {
  local command_name="$1"
  local self_path="${2:-}"
  local candidate

  if [ -z "$self_path" ]; then
    self_path="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/$(basename -- "${BASH_SOURCE[0]}")"
  fi
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    if [ "$candidate" != "$self_path" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done < <(which -a "$command_name" 2>/dev/null || true)

  return 1
}
