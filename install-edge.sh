#!/usr/bin/env bash
# ============================================================================
#  Ari RTMP — EDGE / SUB-SERVER installer
#  Target: Ubuntu 24.04 LTS (x86_64)
#
#  Sets up an edge relay that pulls HLS from the origin, caches media
#  segments, validates every request against the origin, and reports health
#  so the player can load-balance segment downloads across edges.
#
#  Usage:  sudo bash install-edge.sh
#
#  Prerequisite: a registration token generated in the origin dashboard
#  (Edge Servers → Generate / rotate).
# ============================================================================
set -euo pipefail

if [[ -t 1 ]]; then
  C_RESET='\033[0m'; C_RED='\033[0;31m'; C_GREEN='\033[0;32m'
  C_YELLOW='\033[1;33m'; C_BLUE='\033[0;34m'; C_BOLD='\033[1m'
else
  C_RESET=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_BOLD=''
fi
log()  { echo -e "${C_GREEN}==>${C_RESET} ${C_BOLD}$*${C_RESET}"; }
info() { echo -e "${C_BLUE}  •${C_RESET} $*"; }
warn() { echo -e "${C_YELLOW}  !${C_RESET} $*"; }
err()  { echo -e "${C_RED}  ✗${C_RESET} $*" >&2; }
die()  { err "$*"; exit 1; }

trap 'err "Edge installation failed on line $LINENO."' ERR

EDGE_DIR="/opt/ari-edge"
EDGE_CONF="/etc/ari-edge/config"
CERTBOT_WEBROOT="/var/www/certbot"
SITE_NAME="ari-edge"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[[ "${EUID}" -eq 0 ]] || die "Please run as root:  sudo bash install-edge.sh"

clear || true
cat <<'BANNER'
   ___         _   ___ _____ __  __ ___
  / _ \       (_) | _ \_   _|  \/  | _ \
 / /_\ \_ __  _  |   / | | | |\/| |  _/
 |  _  | '__|| | | |\ \ | | | |  | | |
 | | | | |   | | | | \ \| |_| |  | | |
 \_| |_/_|   |_| |_|  \_\___/|_|  |_|_|
       Edge / sub-server installer
BANNER
echo

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ "${ID:-}" == "ubuntu" ]] || warn "Targets Ubuntu 24.04 (detected: ${ID:-unknown}). Continuing."
fi

# ── Prompts ────────────────────────────────────────────────────────────────
echo
log "Configuration"

while :; do
  read -rp "Origin base URL (e.g. https://stream.example.com): " ORIGIN_URL
  [[ -n "${ORIGIN_URL}" ]] && break
  warn "Origin URL is required."
done
ORIGIN_URL="${ORIGIN_URL%/}"
[[ "${ORIGIN_URL}" =~ ^https?:// ]] || ORIGIN_URL="https://${ORIGIN_URL}"
ORIGIN_HOST="$(printf '%s' "${ORIGIN_URL}" | sed -E 's#^https?://##; s#/.*$##')"

while :; do
  read -rp "This edge's public base URL (e.g. https://edge1.example.com or http://IP): " EDGE_URL
  [[ -n "${EDGE_URL}" ]] && break
  warn "Edge URL is required."
done
EDGE_URL="${EDGE_URL%/}"
[[ "${EDGE_URL}" =~ ^https?:// ]] || EDGE_URL="https://${EDGE_URL}"

read -rp "Edge display name [$(hostname -s)]: " EDGE_NAME
EDGE_NAME="${EDGE_NAME:-$(hostname -s)}"

read -rp "Region label (optional): " EDGE_REGION

while :; do
  read -rp "Edge registration token (from the dashboard): " REG_TOKEN
  [[ -n "${REG_TOKEN}" ]] && break
  warn "Registration token is required."
done

echo
read -rp "Configure a domain name with SSL for this edge? (y/n) [n]: " USE_SSL_ANSWER
USE_SSL_ANSWER="${USE_SSL_ANSWER:-n}"
USE_SSL="no"; SERVER_NAME="_"; SSL_EMAIL=""; SSL_CERT=""; SSL_KEY=""; EDGE_DOMAIN=""
if [[ "${USE_SSL_ANSWER,,}" == "y" || "${USE_SSL_ANSWER,,}" == "yes" ]]; then
  USE_SSL="yes"
  EDGE_DOMAIN="$(printf '%s' "${EDGE_URL}" | sed -E 's#^https?://##; s#/.*$##')"
  SERVER_NAME="${EDGE_DOMAIN}"
  SSL_CERT="/etc/letsencrypt/live/${EDGE_DOMAIN}/fullchain.pem"
  SSL_KEY="/etc/letsencrypt/live/${EDGE_DOMAIN}/privkey.pem"
  while :; do
    read -rp "Email for Let's Encrypt notices: " SSL_EMAIL
    [[ -n "${SSL_EMAIL}" ]] && break
  done
fi

echo
log "Summary"
info "Origin:        ${ORIGIN_URL}"
info "This edge:     ${EDGE_URL}  (${EDGE_NAME}${EDGE_REGION:+, ${EDGE_REGION}})"
info "SSL:           ${USE_SSL}${EDGE_DOMAIN:+ (${EDGE_DOMAIN})}"
read -rp "Proceed? (y/n) [y]: " PROCEED
PROCEED="${PROCEED:-y}"
[[ "${PROCEED,,}" == "y" || "${PROCEED,,}" == "yes" ]] || die "Aborted."

# ── Packages ───────────────────────────────────────────────────────────────
log "Installing packages (nginx, certbot, curl, openssl)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y nginx certbot curl openssl ca-certificates

mkdir -p "${CERTBOT_WEBROOT}" /var/cache/nginx/ari /etc/ari-edge "${EDGE_DIR}"
chown -R www-data:www-data "${CERTBOT_WEBROOT}" /var/cache/nginx/ari

# ── Nginx site (HTTP first, so ACME can run) ───────────────────────────────
log "Writing Nginx edge configuration"

render_edge() {
  local tpl="$1" out="$2"
  sed \
    -e "s|__EDGE_SERVER_NAME__|${SERVER_NAME}|g" \
    -e "s|__ORIGIN_URL__|${ORIGIN_URL}|g" \
    -e "s|__ORIGIN_HOST__|${ORIGIN_HOST}|g" \
    -e "s|__SSL_CERT__|${SSL_CERT}|g" \
    -e "s|__SSL_KEY__|${SSL_KEY}|g" \
    "${tpl}" > "${out}"
}

render_edge "${SRC_DIR}/nginx/edge-http.conf.template" "/etc/nginx/sites-available/${SITE_NAME}"
ln -sf "/etc/nginx/sites-available/${SITE_NAME}" "/etc/nginx/sites-enabled/${SITE_NAME}"
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl enable --now nginx
systemctl reload nginx

# ── SSL (optional) ─────────────────────────────────────────────────────────
if [[ "${USE_SSL}" == "yes" ]]; then
  log "Requesting certificate for ${EDGE_DOMAIN}"
  if certbot certonly --webroot -w "${CERTBOT_WEBROOT}" \
        -d "${EDGE_DOMAIN}" --email "${SSL_EMAIL}" \
        --agree-tos --non-interactive --keep-until-expiring; then
    render_edge "${SRC_DIR}/nginx/edge-ssl.conf.template" "/etc/nginx/sites-available/${SITE_NAME}"
    mkdir -p /etc/letsencrypt/renewal-hooks/deploy
    printf '#!/usr/bin/env bash\nsystemctl reload nginx\n' \
      > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
    chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
    systemctl enable --now certbot.timer 2>/dev/null || true
    nginx -t && systemctl reload nginx
    info "HTTPS enabled for the edge."
  else
    warn "Certbot failed; continuing with HTTP for this edge."
    USE_SSL="no"
  fi
fi

# ── Register with the origin ───────────────────────────────────────────────
log "Registering with the origin"
REG_RESPONSE=""
if command -v python3 >/dev/null 2>&1; then
  REG_RESPONSE="$(curl -fsS --max-time 15 -X POST "${ORIGIN_URL}/api/edges/register" \
    -H 'Content-Type: application/json' \
    -d "$(printf '{"token":"%s","name":"%s","baseUrl":"%s","region":"%s"}' \
          "$REG_TOKEN" "$EDGE_NAME" "$EDGE_URL" "$EDGE_REGION")" || true)"
fi

EDGE_ID=""; EDGE_SECRET=""
if [[ -n "${REG_RESPONSE}" ]]; then
  EDGE_ID="$(printf '%s' "${REG_RESPONSE}" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("edgeId",""))' 2>/dev/null || true)"
  EDGE_SECRET="$(printf '%s' "${REG_RESPONSE}" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("secret",""))' 2>/dev/null || true)"
fi

if [[ -n "${EDGE_ID}" && -n "${EDGE_SECRET}" ]]; then
  info "Registered as edge id ${EDGE_ID}"
else
  warn "Auto-registration failed. Add this edge manually in the dashboard:"
  warn "  Base URL: ${EDGE_URL}"
fi

cat > "${EDGE_CONF}" <<CONF
# Ari RTMP edge configuration — do not commit. Generated $(date -Is).
ORIGIN_URL="${ORIGIN_URL}"
EDGE_NAME="${EDGE_NAME}"
EDGE_URL="${EDGE_URL}"
REGION="${EDGE_REGION}"
EDGE_ID="${EDGE_ID}"
EDGE_SECRET="${EDGE_SECRET}"
CONF
chmod 600 "${EDGE_CONF}"

# ── Heartbeat ──────────────────────────────────────────────────────────────
log "Installing heartbeat service"
cp "${SRC_DIR}/scripts/edge-heartbeat.sh" "${EDGE_DIR}/edge-heartbeat.sh"
chmod +x "${EDGE_DIR}/edge-heartbeat.sh"
cp "${SRC_DIR}/systemd/ari-edge-heartbeat.service" /etc/systemd/system/ari-edge-heartbeat.service
cp "${SRC_DIR}/systemd/ari-edge-heartbeat.timer"   /etc/systemd/system/ari-edge-heartbeat.timer
systemctl daemon-reload
systemctl enable --now ari-edge-heartbeat.timer
"${EDGE_DIR}/edge-heartbeat.sh" || warn "First heartbeat failed (will retry on the timer)."

# ── Firewall ───────────────────────────────────────────────────────────────
if [[ "${ARI_SKIP_FIREWALL:-0}" != "1" ]]; then
  log "Configuring UFW"
  ufw allow 22/tcp  >/dev/null 2>&1 || true
  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  ufw --force enable >/dev/null 2>&1 || warn "UFW could not be enabled (skipping)."
else
  info "Skipping firewall configuration (ARI_SKIP_FIREWALL=1)."
fi

# ── Verify ─────────────────────────────────────────────────────────────────
log "Verifying"
sleep 1
systemctl --no-pager --quiet is-active nginx && info "nginx: active" || warn "nginx: not active"
systemctl --no-pager --quiet is-active ari-edge-heartbeat.timer && info "heartbeat timer: active" || warn "heartbeat timer: not active"
curl -fsS --max-time 5 "${EDGE_URL}/edge/health" >/dev/null 2>&1 && info "health endpoint: ok" || warn "health endpoint not reachable via ${EDGE_URL} (check DNS/firewall)"

echo
cat <<DONE
${C_GREEN}${C_BOLD}============================================================
 Edge installation complete
============================================================${C_RESET}

  Origin:     ${ORIGIN_URL}
  This edge:  ${EDGE_URL}
  Edge id:    ${EDGE_ID:-<not registered>}
  Cache dir:  /var/cache/nginx/ari

  The origin dashboard should now list this edge as healthy within ~30s.
  The player load-balances segment downloads across all healthy edges.

  Manage
  ------
    sudo systemctl status nginx
    sudo systemctl status ari-edge-heartbeat.timer
    sudo nginx -t
    sudo tail -f /var/log/nginx/access.log

DONE
