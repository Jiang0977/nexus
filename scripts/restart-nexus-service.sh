#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/nexus-systemd.sh"
SERVICE_NAME="${1:-${NEXUS_SERVICE_NAME:-nexus}}"
export NEXUS_SERVICE_NAME="$SERVICE_NAME"
nexus_resolve_service_scope
NEXUS_HOST="${NEXUS_HOST:-127.0.0.1}"
NEXUS_PORT="${PORT:-59000}"
HEALTHCHECK_URL="${NEXUS_HEALTHCHECK_URL:-http://${NEXUS_HOST}:${NEXUS_PORT}/api/version}"

echo "[Nexus] Restarting ${SERVICE_NAME} (${NEXUS_SERVICE_SCOPE} service)..."
nexus_systemctl restart "${SERVICE_NAME}"

echo "[Nexus] Checking ${SERVICE_NAME} status..."
nexus_systemctl status "${SERVICE_NAME}" --no-pager

echo "[Nexus] Verifying HTTP healthcheck at ${HEALTHCHECK_URL}..."
health_output="$(mktemp /tmp/nexus-healthcheck.XXXXXX)"
trap 'rm -f "$health_output"' EXIT
http_code="000"
for _ in $(seq 1 20); do
    http_code="$(curl -s -o "$health_output" -w '%{http_code}' --max-time 5 "${HEALTHCHECK_URL}" || true)"
    if [ "${http_code}" = "200" ] || [ "${http_code}" = "401" ]; then
        break
    fi
    sleep 0.5
done

if [ "${http_code}" != "200" ] && [ "${http_code}" != "401" ]; then
    echo "[Nexus] Healthcheck failed with HTTP ${http_code:-curl-error}" >&2
    if [ -f "$health_output" ]; then
        cat "$health_output" >&2
    fi
    exit 1
fi

echo "[Nexus] Healthcheck ok: HTTP ${http_code}"
