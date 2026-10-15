#!/usr/bin/env bash
# Ari RTMP origin Nginx entrypoint — renders config from templates using
# container environment variables, then runs Nginx in the foreground.
set -euo pipefail

TPL_DIR="/opt/templates"
NGINX_CONF="/usr/local/nginx/conf/nginx.conf"
RTMP_CONF="/usr/local/nginx/conf/rtmp.conf"

APP_UPSTREAM="${APP_UPSTREAM:-app:3000}"
SERVER_NAME="${SERVER_NAME:-_}"
HLS_ROOT="${HLS_ROOT:-/var/www/hls}"
INTERNAL_TOKEN="${INTERNAL_TOKEN:-}"
TRANSCODE_SCRIPT="${TRANSCODE_SCRIPT:-/opt/hls-transcode.sh}"
RTMP_INGEST_URL="${RTMP_INGEST_URL:-rtmp://127.0.0.1:1935/live}"
SSL_CERT="${SSL_CERT:-/etc/letsencrypt/live/${SERVER_NAME}/fullchain.pem}"
SSL_KEY="${SSL_KEY:-/etc/letsencrypt/live/${SERVER_NAME}/privkey.pem}"

mkdir -p "${HLS_ROOT}" /var/www/certbot /var/log/nginx /run
chown -R www-data:www-data "${HLS_ROOT}" /var/www/certbot /var/log/nginx 2>/dev/null || true

render() {
  sed \
    -e "s|__APP_UPSTREAM__|${APP_UPSTREAM}|g" \
    -e "s|__SERVER_NAME__|${SERVER_NAME}|g" \
    -e "s|__HLS_ROOT__|${HLS_ROOT}|g" \
    -e "s|__INTERNAL_TOKEN__|${INTERNAL_TOKEN}|g" \
    -e "s|__TRANSCODE_SCRIPT__|${TRANSCODE_SCRIPT}|g" \
    -e "s|__RTMP_INGEST_URL__|${RTMP_INGEST_URL}|g" \
    -e "s|__SSL_CERT__|${SSL_CERT}|g" \
    -e "s|__SSL_KEY__|${SSL_KEY}|g" \
    "$1" > "$2"
}

# Render the ABR transcoder script.
render "${TPL_DIR}/hls-transcode.sh" "${TRANSCODE_SCRIPT}"
chmod +x "${TRANSCODE_SCRIPT}"

if [[ "${SERVER_NAME}" != "_" && -f "${SSL_CERT}" ]]; then
  echo "[nginx] SSL mode for ${SERVER_NAME}"
  render "${TPL_DIR}/nginx-ssl.conf.template" "${NGINX_CONF}"
  render "${TPL_DIR}/rtmp-ssl.conf.template"  "${RTMP_CONF}"
else
  echo "[nginx] HTTP mode (server_name=${SERVER_NAME})"
  render "${TPL_DIR}/nginx-ip.conf.template" "${NGINX_CONF}"
  render "${TPL_DIR}/rtmp-ip.conf.template"  "${RTMP_CONF}"
fi

/usr/local/nginx/sbin/nginx -t
echo "[nginx] starting (app upstream: ${APP_UPSTREAM})"
exec /usr/local/nginx/sbin/nginx -g 'daemon off;'
