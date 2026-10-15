#!/bin/bash
# Ari RTMP edge — self-registration + heartbeat loop.
# Registers with the origin once (using the dashboard token), persists its
# identity, then reports load every 30 seconds.
set -uo pipefail

CONF="/etc/ari-edge/config"

if [ -f "$CONF" ]; then
  # shellcheck disable=SC1090
  . "$CONF"
fi

ORIGIN_URL="${ORIGIN_URL%/}"

register() {
  [ -n "${EDGE_ID:-}" ] && return 0
  [ -n "${EDGE_REGISTRATION_TOKEN:-}" ] || { echo "[edge] no registration token; add this edge manually in the dashboard"; return 1; }

  local payload resp
  payload="$(jq -n \
    --arg t "$EDGE_REGISTRATION_TOKEN" \
    --arg n "${EDGE_NAME:-edge}" \
    --arg u "${EDGE_URL:-}" \
    --arg r "${EDGE_REGION:-}" \
    '{token:$t,name:$n,baseUrl:$u,region:$r}')"

  resp="$(curl -fsS --max-time 15 -X POST "${ORIGIN_URL}/api/edges/register" \
    -H 'Content-Type: application/json' -d "$payload" 2>/dev/null || true)"

  EDGE_ID="$(printf '%s' "$resp" | jq -r '.edgeId // empty' 2>/dev/null || true)"
  EDGE_SECRET="$(printf '%s' "$resp" | jq -r '.secret // empty' 2>/dev/null || true)"

  if [ -n "$EDGE_ID" ] && [ -n "$EDGE_SECRET" ]; then
    cat > "$CONF" <<EOF
ORIGIN_URL="${ORIGIN_URL}"
EDGE_NAME="${EDGE_NAME:-edge}"
EDGE_URL="${EDGE_URL:-}"
REGION="${EDGE_REGION:-}"
EDGE_ID="${EDGE_ID}"
EDGE_SECRET="${EDGE_SECRET}"
EOF
    chmod 600 "$CONF"
    echo "[edge] registered as ${EDGE_ID}"
    return 0
  fi
  echo "[edge] registration failed; will retry"
  return 1
}

beat() {
  local load n pct
  load="$(awk '{print $1}' /proc/loadavg 2>/dev/null || echo 0)"
  n="$(nproc 2>/dev/null || echo 1)"
  pct="$(awk -v l="$load" -v n="$n" 'BEGIN{p=(l/n)*100; if(p>100)p=100; if(p<0)p=0; printf "%d",p}')"
  curl -fsS --max-time 10 -X POST "${ORIGIN_URL}/api/edges/heartbeat" \
    -H 'Content-Type: application/json' \
    -d "{\"edgeId\":\"${EDGE_ID}\",\"secret\":\"${EDGE_SECRET}\",\"loadPct\":${pct},\"version\":\"ari-edge-docker/1.0\"}" \
    >/dev/null 2>&1 || true
}

echo "[edge] heartbeat loop started for origin ${ORIGIN_URL}"
while true; do
  register || true
  if [ -n "${EDGE_ID:-}" ] && [ -n "${EDGE_SECRET:-}" ]; then
    beat
  fi
  sleep 30
done
