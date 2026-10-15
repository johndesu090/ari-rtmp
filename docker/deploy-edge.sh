#!/usr/bin/env bash
# ============================================================================
#  Ari RTMP — Docker deploy helper (edge / sub-server)
#  Generates .env.edge, builds the edge image and starts the relay.
#
#  Usage:  ./docker/deploy-edge.sh
# ============================================================================
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if docker compose version >/dev/null 2>&1; then DC="docker compose"; else DC="docker-compose"; fi
COMPOSE_FILE="docker-compose.edge.yml"

if [[ ! -f .env.edge ]]; then
  echo "No .env.edge found — let's create one."
  read -rp "Origin base URL (e.g. https://stream.example.com): " ORIGIN_URL
  while [[ -z "${ORIGIN_URL}" ]]; do read -rp "Origin base URL is required: " ORIGIN_URL; done

  DEFAULT_EDGE="http://$(hostname -I 2>/dev/null | awk '{print $1}')"
  read -rp "This edge's public base URL [${DEFAULT_EDGE}]: " EDGE_URL
  EDGE_URL="${EDGE_URL:-$DEFAULT_EDGE}"

  read -rp "Edge display name [$(hostname -s)]: " EDGE_NAME
  EDGE_NAME="${EDGE_NAME:-$(hostname -s)}"
  read -rp "Region label (optional): " EDGE_REGION
  read -rp "Edge registration token (from dashboard): " EDGE_REGISTRATION_TOKEN

  cp .env.edge.example .env.edge
  sed -i.bak \
    -e "s|^ORIGIN_URL=.*|ORIGIN_URL=${ORIGIN_URL%/}|" \
    -e "s|^EDGE_URL=.*|EDGE_URL=${EDGE_URL%/}|" \
    -e "s|^EDGE_NAME=.*|EDGE_NAME=${EDGE_NAME}|" \
    -e "s|^EDGE_REGION=.*|EDGE_REGION=${EDGE_REGION}|" \
    -e "s|^EDGE_REGISTRATION_TOKEN=.*|EDGE_REGISTRATION_TOKEN=${EDGE_REGISTRATION_TOKEN}|" \
    .env.edge
  rm -f .env.edge.bak
  echo "Wrote .env.edge"
fi

echo "==> Building and starting the edge"
$DC -f "$COMPOSE_FILE" up -d --build

echo
echo "============================================================"
echo " Ari RTMP edge is up"
echo "============================================================"
echo "  Origin:   $(grep -E '^ORIGIN_URL=' .env.edge | cut -d= -f2-)"
echo "  This edge: $(grep -E '^EDGE_URL=' .env.edge | cut -d= -f2-)"
echo
echo "  Logs:     $DC -f $COMPOSE_FILE logs -f edge"
echo "  Status:   $DC -f $COMPOSE_FILE ps"
echo "  Stop:     $DC -f $COMPOSE_FILE down"
echo
echo "  The origin dashboard should list this edge as healthy within ~30s."
echo
