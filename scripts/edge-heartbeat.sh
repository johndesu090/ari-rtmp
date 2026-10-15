#!/usr/bin/env bash
# ── Ari RTMP — edge heartbeat ──────────────────────────────────────────
# Posts load telemetry to the origin so the dashboard can show edge health
# and so the player only load-balances to live edges.
set -euo pipefail

CONF="/etc/ari-edge/config"
[[ -f "$CONF" ]] || exit 0
# shellcheck disable=SC1090
. "$CONF"

[[ -n "${ORIGIN_URL:-}" && -n "${EDGE_ID:-}" && -n "${EDGE_SECRET:-}" ]] || exit 0

NPROC="$(nproc 2>/dev/null || echo 1)"
LOAD1="$(awk '{print $1}' /proc/loadavg 2>/dev/null || echo 0)"
LOAD_PCT="$(awk -v l="$LOAD1" -v n="$NPROC" 'BEGIN { p=(l/n)*100; if (p>100) p=100; if (p<0) p=0; printf "%d", p }')"

payload="$(printf '{"edgeId":"%s","secret":"%s","loadPct":%s,"version":"ari-edge/1.0"}' \
  "$EDGE_ID" "$EDGE_SECRET" "$LOAD_PCT")"

curl -fsS --max-time 10 -X POST "${ORIGIN_URL}/api/edges/heartbeat" \
  -H 'Content-Type: application/json' -d "$payload" >/dev/null 2>&1 || true
