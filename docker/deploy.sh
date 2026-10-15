#!/usr/bin/env bash
# ============================================================================
#  Ari RTMP — Docker deploy helper (origin)
#  Generates .env (with secrets), builds images and starts the stack.
#  Optionally provisions a Let's Encrypt certificate via the certbot service.
#
#  Usage:  ./docker/deploy.sh
# ============================================================================
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

command -v docker >/dev/null 2>&1 || { echo "docker is required."; exit 1; }
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  echo "docker compose (v2) or docker-compose is required."; exit 1
fi

gen() { openssl rand -hex "$1" 2>/dev/null || head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

if [[ ! -f .env ]]; then
  echo "No .env found — let's create one."
  DEFAULT_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  DEFAULT_IP="${DEFAULT_IP:-127.0.0.1}"

  read -rp "Use a domain with SSL? (y/n) [n]: " USE_SSL
  USE_SSL="${USE_SSL:-n}"
  DOMAIN=""; SERVER_NAME="_"; PUBLIC_BASE_URL="http://${DEFAULT_IP}"
  if [[ "${USE_SSL,,}" == "y" || "${USE_SSL,,}" == "yes" ]]; then
    read -rp "Domain (e.g. stream.example.com): " DOMAIN
    read -rp "Email for Let's Encrypt: " SSL_EMAIL
    SERVER_NAME="${DOMAIN}"
    PUBLIC_BASE_URL="https://${DOMAIN}"
  else
    read -rp "Public base URL [${PUBLIC_BASE_URL}]: " PB
    PUBLIC_BASE_URL="${PB:-$PUBLIC_BASE_URL}"
  fi

  cp .env.docker.example .env
  sed -i.bak \
    -e "s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=${PUBLIC_BASE_URL}|" \
    -e "s|^SERVER_NAME=.*|SERVER_NAME=${SERVER_NAME}|" \
    -e "s|^DOMAIN=.*|DOMAIN=${DOMAIN}|" \
    -e "s|^DB_PASSWORD=.*|DB_PASSWORD=$(gen 16)|" \
    -e "s|^JWT_SECRET=.*|JWT_SECRET=$(gen 32)|" \
    -e "s|^SESSION_SECRET=.*|SESSION_SECRET=$(gen 32)|" \
    -e "s|^INTERNAL_API_TOKEN=.*|INTERNAL_API_TOKEN=$(gen 24)|" \
    .env
  rm -f .env.bak
  echo "Wrote .env"
fi

echo "==> Building and starting the stack"
$DC up -d --build

if [[ -n "${DOMAIN:-$(grep -E '^DOMAIN=' .env | cut -d= -f2-)}" ]]; then
  DOMAIN_VALUE="$(grep -E '^DOMAIN=' .env | cut -d= -f2-)"
  if [[ -n "${DOMAIN_VALUE}" ]]; then
    echo
    echo "==> Requesting SSL certificate for ${DOMAIN_VALUE}"
    read -rp "Email for Let's Encrypt (blank to skip SSL): " SSL_EMAIL
    if [[ -n "${SSL_EMAIL}" ]]; then
      $DC run --rm certbot certonly --webroot -w /var/www/certbot \
        -d "${DOMAIN_VALUE}" --email "${SSL_EMAIL}" \
        --agree-tos --non-interactive --keep-until-expiring || \
        echo "Certbot failed — check DNS for ${DOMAIN_VALUE} and port 80."
      $DC restart nginx
    fi
  fi
fi

echo
echo "============================================================"
echo " Ari RTMP (Docker) is up"
echo "============================================================"
echo "  Dashboard:  $(grep -E '^PUBLIC_BASE_URL=' .env | cut -d= -f2-)/"
echo "  RTMP:       rtmp://<host>:1935/live  (RTMPS on :1936 when SSL)"
echo
echo "  Logs:       $DC logs -f app nginx"
echo "  Status:     $DC ps"
echo "  Stop:       $DC down"
echo "  SSL renew:  $DC run --rm certbot renew && $DC restart nginx"
echo
