#!/bin/bash

set -euo pipefail

SERVICE_NAME="${1:-nexus}"
NEXUS_HOST="${NEXUS_HOST:-127.0.0.1}"
NEXUS_PORT="${PORT:-59000}"
HEALTHCHECK_URL="${NEXUS_HEALTHCHECK_URL:-http://${NEXUS_HOST}:${NEXUS_PORT}/api/version}"

echo "[Nexus] Restarting ${SERVICE_NAME} via sudo..."
sudo -n systemctl restart "${SERVICE_NAME}"

echo "[Nexus] Checking ${SERVICE_NAME} status..."
sudo -n systemctl status "${SERVICE_NAME}" --no-pager

echo "[Nexus] Verifying HTTP healthcheck at ${HEALTHCHECK_URL}..."
http_code="000"
for _ in $(seq 1 20); do
    http_code="$(curl -s -o /tmp/nexus-healthcheck.out -w '%{http_code}' --max-time 5 "${HEALTHCHECK_URL}" || true)"
    if [ "${http_code}" = "200" ] || [ "${http_code}" = "401" ]; then
        break
    fi
    sleep 0.5
done

if [ "${http_code}" != "200" ] && [ "${http_code}" != "401" ]; then
    echo "[Nexus] Healthcheck failed with HTTP ${http_code:-curl-error}" >&2
    if [ -f /tmp/nexus-healthcheck.out ]; then
        cat /tmp/nexus-healthcheck.out >&2
    fi
    exit 1
fi

echo "[Nexus] Healthcheck ok: HTTP ${http_code}"
