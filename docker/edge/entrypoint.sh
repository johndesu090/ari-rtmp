#!/bin/bash
# Ari RTMP edge entrypoint — renders the caching relay config from env,
# starts the registration/heartbeat loop, and runs Nginx in the foreground.
set -euo pipefail

rm -f /etc/nginx/conf.d/default.conf
mkdir -p /var/cache/nginx/ari /var/www/certbot /etc/ari-edge
chown -R nginx:nginx /var/cache/nginx/ari /var/www/certbot 2>/dev/null || true

ORIGIN_URL="${ORIGIN_URL:?ORIGIN_URL is required}"
ORIGIN_URL="${ORIGIN_URL%/}"
ORIGIN_HOST="$(printf '%s' "$ORIGIN_URL" | sed -E 's#^https?://##; s#/.*$##')"

EDGE_URL="${EDGE_URL:-}"
EDGE_SERVER_NAME="${EDGE_SERVER_NAME:-$(printf '%s' "$EDGE_URL" | sed -E 's#^https?://##; s#/.*$##')}"
[ -n "$EDGE_SERVER_NAME" ] || EDGE_SERVER_NAME="_"

SSL_CERT="/etc/letsencrypt/live/${EDGE_SERVER_NAME}/fullchain.pem"
SSL_KEY="/etc/letsencrypt/live/${EDGE_SERVER_NAME}/privkey.pem"

render() {
  sed \
    -e "s|__EDGE_SERVER_NAME__|${EDGE_SERVER_NAME}|g" \
    -e "s|__ORIGIN_URL__|${ORIGIN_URL}|g" \
    -e "s|__ORIGIN_HOST__|${ORIGIN_HOST}|g" \
    -e "s|__SSL_CERT__|${SSL_CERT}|g" \
    -e "s|__SSL_KEY__|${SSL_KEY}|g" \
    "$1" > "$2"
}

if [ "$EDGE_SERVER_NAME" != "_" ] && [ -f "$SSL_CERT" ]; then
  echo "[edge] SSL mode for ${EDGE_SERVER_NAME}"
  render /opt/templates/edge-ssl.conf.template /etc/nginx/conf.d/edge.conf
else
  echo "[edge] HTTP mode (server_name=${EDGE_SERVER_NAME})"
  render /opt/templates/edge-http.conf.template /etc/nginx/conf.d/edge.conf
fi

# Registration + heartbeat in the background.
/opt/heartbeat.sh &

nginx -t
echo "[edge] starting, origin=${ORIGIN_URL}"
exec nginx -g 'daemon off;'
