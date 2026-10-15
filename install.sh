#!/usr/bin/env bash
# ============================================================================
#  Ari RTMP — interactive one-click installer
#  Target: Ubuntu 24.04 LTS (x86_64)
#
#  Installs: Node.js, PostgreSQL, Redis, FFmpeg, Nginx (compiled with
#  nginx-rtmp-module), the Ari RTMP API/dashboard, systemd services, and
#  optionally Let's Encrypt SSL via Certbot (with auto-renewal).
#
#  Usage:  sudo bash install.sh
# ============================================================================
set -euo pipefail

# ── Colours ────────────────────────────────────────────────────────────────
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

trap 'err "Installation failed on line $LINENO."' ERR

# ── Constants ──────────────────────────────────────────────────────────────
APP_DIR="/opt/ari-rtmp"
HLS_ROOT="/var/www/hls"
CERTBOT_WEBROOT="/var/www/certbot"
NGINX_PREFIX="/usr/local/nginx"
NGINX_VERSION="1.26.2"
RTMP_MODULE_VERSION="v1.2.2"
NODE_MAJOR="20"
DB_NAME="ari_rtmp"
DB_USER="ari_rtmp"
APP_PORT="3000"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Root check ─────────────────────────────────────────────────────────────
[[ "${EUID}" -eq 0 ]] || die "Please run as root:  sudo bash install.sh"

# ── Banner ─────────────────────────────────────────────────────────────────
clear || true
cat <<'BANNER'
   ___         _   ___ _____ __  __ ___
  / _ \       (_) | _ \_   _|  \/  | _ \
 / /_\ \_ __  _  |   / | | | |\/| |  _/
 |  _  | '__|| | | |\ \ | | | |  | | |
 | | | | |   | | | | \ \| |_| |  | | |
 \_| |_/_|   |_| |_|  \_\___/|_|  |_|_|
      Self-hosted low-latency HLS streaming
BANNER
echo

# ── OS check ───────────────────────────────────────────────────────────────
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  if [[ "${ID:-}" != "ubuntu" ]]; then
    warn "This installer targets Ubuntu 24.04 (detected: ${ID:-unknown}). Continuing anyway."
  elif [[ "${VERSION_ID:-}" != "24.04" ]]; then
    warn "Designed for Ubuntu 24.04 (detected: ${VERSION_ID:-unknown}). Continuing anyway."
  else
    info "Detected Ubuntu 24.04 — good."
  fi
else
  warn "Could not read /etc/os-release; continuing."
fi

# ── Interactive configuration ──────────────────────────────────────────────
echo
log "Configuration"

read -rp "Do you want to configure a domain name with SSL? (y/n) [n]: " USE_SSL_ANSWER
USE_SSL_ANSWER="${USE_SSL_ANSWER:-n}"

USE_SSL="no"
DOMAIN=""
SSL_EMAIL=""
SERVER_NAME="_"
PUBLIC_BASE_URL=""
SSL_CERT=""
SSL_KEY=""

if [[ "${USE_SSL_ANSWER,,}" == "y" || "${USE_SSL_ANSWER,,}" == "yes" ]]; then
  USE_SSL="yes"
  while :; do
    read -rp "Enter your domain name (e.g. stream.example.com): " DOMAIN
    [[ -n "${DOMAIN}" ]] && break
    warn "Domain cannot be empty."
  done
  # Strip scheme/path if pasted.
  DOMAIN="${DOMAIN#*://}"; DOMAIN="${DOMAIN%%/*}"; DOMAIN="${DOMAIN%%:*}"
  while :; do
    read -rp "Enter an email for Let's Encrypt notices: " SSL_EMAIL
    [[ -n "${SSL_EMAIL}" ]] && break
    warn "Email cannot be empty."
  done
  SERVER_NAME="${DOMAIN}"
  PUBLIC_BASE_URL="https://${DOMAIN}"
  SSL_CERT="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
  SSL_KEY="/etc/letsencrypt/live/${DOMAIN}/privkey.pem"
  info "SSL enabled for ${DOMAIN}."
else
  # Best-effort public IP for the base URL.
  PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  [[ -z "${PUBLIC_IP}" ]] && PUBLIC_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [[ -z "${PUBLIC_IP}" ]] && PUBLIC_IP="127.0.0.1"
  PUBLIC_BASE_URL="http://${PUBLIC_IP}"
  info "Running in HTTP/IP mode. Public base URL: ${PUBLIC_BASE_URL}"
fi

echo
read -rp "Admin dashboard port (internal) [${APP_PORT}]: " PORT_INPUT
APP_PORT="${PORT_INPUT:-${APP_PORT}}"

echo
log "Summary"
info "App directory:     ${APP_DIR}"
info "HLS root:          ${HLS_ROOT}"
info "Nginx prefix:      ${NGINX_PREFIX}"
info "Internal API port: ${APP_PORT}"
info "Public base URL:   ${PUBLIC_BASE_URL}"
info "SSL:               ${USE_SSL}${DOMAIN:+ (${DOMAIN})}"
echo
read -rp "Proceed with installation? (y/n) [y]: " PROCEED
PROCEED="${PROCEED:-y}"
[[ "${PROCEED,,}" == "y" || "${PROCEED,,}" == "yes" ]] || die "Aborted by user."

# ── Generate secrets ───────────────────────────────────────────────────────
DB_PASS="$(openssl rand -hex 16)"
JWT_SECRET="$(openssl rand -hex 32)"
SESSION_SECRET="$(openssl rand -hex 32)"
INTERNAL_TOKEN="$(openssl rand -hex 24)"

# ── Step 1: system packages ────────────────────────────────────────────────
log "Updating apt and installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y \
  build-essential libpcre3-dev libssl-dev zlib1g-dev libgd-dev \
  git curl wget ca-certificates gnupg lsb-release rsync \
  postgresql postgresql-contrib redis-server ffmpeg \
  certbot openssl ufw

# ── Step 2: Node.js ────────────────────────────────────────────────────────
log "Installing Node.js ${NODE_MAJOR}.x"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt "${NODE_MAJOR}" ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
info "Node $(node -v), npm $(npm -v)"

# ── Step 3: Nginx with nginx-rtmp-module ───────────────────────────────────
log "Compiling Nginx ${NGINX_VERSION} with nginx-rtmp-module ${RTMP_MODULE_VERSION}"
mkdir -p /usr/local/src
cd /usr/local/src

if [[ ! -d "nginx-${NGINX_VERSION}" ]]; then
  curl -fsSLO "https://nginx.org/download/nginx-${NGINX_VERSION}.tar.gz"
  tar -xzf "nginx-${NGINX_VERSION}.tar.gz"
fi

if [[ ! -d nginx-rtmp-module ]]; then
  git clone --depth 1 --branch "${RTMP_MODULE_VERSION}" \
    https://github.com/arut/nginx-rtmp-module.git
fi

cd "nginx-${NGINX_VERSION}"
./configure \
  --prefix="${NGINX_PREFIX}" \
  --with-http_ssl_module \
  --with-http_v2_module \
  --with-http_realip_module \
  --with-http_stub_status_module \
  --with-http_secure_link_module \
  --with-http_gzip_static_module \
  --with-threads \
  --add-module=/usr/local/src/nginx-rtmp-module
make -j"$(nproc)"
make install

mkdir -p /var/log/nginx /run
info "Nginx installed at ${NGINX_PREFIX}"

# ── Step 4: directories ────────────────────────────────────────────────────
log "Creating data directories"
mkdir -p "${HLS_ROOT}" "${CERTBOT_WEBROOT}" "${APP_DIR}"
chown -R www-data:www-data "${HLS_ROOT}" "${CERTBOT_WEBROOT}"

# ── Step 5: PostgreSQL ─────────────────────────────────────────────────────
log "Configuring PostgreSQL"
systemctl enable --now postgresql

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1; then
  sudo -u postgres psql -c "CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}';"
  info "Created role ${DB_USER}"
else
  sudo -u postgres psql -c "ALTER ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASS}';"
  info "Updated role ${DB_USER}"
fi

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
  sudo -u postgres createdb -O "${DB_USER}" "${DB_NAME}"
  info "Created database ${DB_NAME}"
fi

# ── Step 6: Redis ──────────────────────────────────────────────────────────
log "Enabling Redis"
systemctl enable --now redis-server

# ── Step 7: deploy application ─────────────────────────────────────────────
log "Deploying application to ${APP_DIR}"
rsync -a --delete \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude '.env' \
  "${SRC_DIR}/" "${APP_DIR}/"

cat > "${APP_DIR}/.env" <<ENVFILE
NODE_ENV=production
PORT=${APP_PORT}
HOST=127.0.0.1
PUBLIC_BASE_URL=${PUBLIC_BASE_URL}
JWT_SECRET=${JWT_SECRET}
SESSION_SECRET=${SESSION_SECRET}
DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@127.0.0.1:5432/${DB_NAME}?schema=public
REDIS_URL=redis://127.0.0.1:6379
TOKEN_TTL_SECONDS=60
ADMIN_SESSION_HOURS=24
HLS_ROOT=${HLS_ROOT}
RTMP_INGEST_URL=rtmp://127.0.0.1:1935/live
INTERNAL_API_TOKEN=${INTERNAL_TOKEN}
P2P_ENABLED=true
P2P_MAX_PEERS=5
P2P_MAX_SWARM_PEERS=200
P2P_SNAPSHOT_SECONDS=30
P2P_ICE_SERVERS=stun:stun.l.google.com:19302,stun:global.stun.twilio.com:3478
ENVFILE
chmod 640 "${APP_DIR}/.env"

log "Installing Node dependencies and preparing database"
cd "${APP_DIR}"
npm install --no-audit --no-fund
npx prisma generate
npx prisma db push --skip-generate

chown -R www-data:www-data "${APP_DIR}"
chmod +x "${APP_DIR}/bin/hls-transcode.sh" "${APP_DIR}/scripts/certbot-renew.sh"

# ── Step 8: render Nginx config ────────────────────────────────────────────
log "Rendering Nginx configuration"

render_template() {
  local tpl="$1" out="$2"
  sed \
    -e "s|__APP_UPSTREAM__|127.0.0.1:${APP_PORT}|g" \
    -e "s|__HLS_ROOT__|${HLS_ROOT}|g" \
    -e "s|__SERVER_NAME__|${SERVER_NAME}|g" \
    -e "s|__INTERNAL_TOKEN__|${INTERNAL_TOKEN}|g" \
    -e "s|__TRANSCODE_SCRIPT__|${APP_DIR}/bin/hls-transcode.sh|g" \
    -e "s|__RTMP_INGEST_URL__|rtmp://127.0.0.1:1935/live|g" \
    -e "s|__SSL_CERT__|${SSL_CERT}|g" \
    -e "s|__SSL_KEY__|${SSL_KEY}|g" \
    "${tpl}" > "${out}"
}

# Always start with the IP/HTTP configuration so port 80 is available for
# the ACME challenge (and works immediately in the non-SSL case).
render_template "${APP_DIR}/nginx/nginx-ip.conf.template" "${NGINX_PREFIX}/conf/nginx.conf"
render_template "${APP_DIR}/nginx/rtmp-ip.conf.template"  "${NGINX_PREFIX}/conf/rtmp.conf"

# ── Step 9: systemd services ───────────────────────────────────────────────
log "Installing systemd services"
cp "${APP_DIR}/systemd/nginx.service"   /etc/systemd/system/nginx.service
cp "${APP_DIR}/systemd/ari-rtmp.service" /etc/systemd/system/ari-rtmp.service
systemctl daemon-reload
systemctl enable nginx.service ari-rtmp.service

# Validate and start nginx (IP mode first).
"${NGINX_PREFIX}/sbin/nginx" -t
systemctl restart nginx.service
systemctl restart ari-rtmp.service
info "Services started."

# ── Step 10: firewall ──────────────────────────────────────────────────────
log "Configuring UFW firewall"
ufw allow 22/tcp   >/dev/null 2>&1 || true
ufw allow 80/tcp   >/dev/null 2>&1 || true
ufw allow 443/tcp  >/dev/null 2>&1 || true
ufw allow 1935/tcp >/dev/null 2>&1 || true
ufw allow 1936/tcp >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || warn "UFW could not be enabled (skipping)."

# ── Step 11: SSL via Certbot (optional) ────────────────────────────────────
if [[ "${USE_SSL}" == "yes" ]]; then
  log "Requesting Let's Encrypt certificate for ${DOMAIN}"
  if certbot certonly --webroot -w "${CERTBOT_WEBROOT}" \
        -d "${DOMAIN}" \
        --email "${SSL_EMAIL}" \
        --agree-tos --non-interactive --keep-until-expiring; then

    info "Certificate issued. Switching Nginx to HTTPS + RTMPS."
    render_template "${APP_DIR}/nginx/nginx-ssl.conf.template" "${NGINX_PREFIX}/conf/nginx.conf"
    render_template "${APP_DIR}/nginx/rtmp-ssl.conf.template"  "${NGINX_PREFIX}/conf/rtmp.conf"

    # Reload nginx whenever a certificate is renewed.
    mkdir -p /etc/letsencrypt/renewal-hooks/deploy
    cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'HOOK'
#!/usr/bin/env bash
/usr/local/nginx/sbin/nginx -s reload
HOOK
    chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

    # Ensure the packaged auto-renew timer is active.
    systemctl enable --now certbot.timer 2>/dev/null || true

    # Cron fallback so renewal works even without the systemd timer
    # (e.g. snap-packaged certbot). Idempotent: only renews near expiry.
    cat > /etc/cron.d/ari-rtmp-certbot <<CRON
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
17 3 * * * root ${APP_DIR}/scripts/certbot-renew.sh >> /var/log/ari-rtmp-certbot.log 2>&1
CRON
    chmod 644 /etc/cron.d/ari-rtmp-certbot

    "${NGINX_PREFIX}/sbin/nginx" -t
    systemctl reload nginx.service
    info "HTTPS enabled. Auto-renewal via certbot.timer + cron fallback."
  else
    warn "Certbot failed. Falling back to HTTP/IP mode."
    warn "Check that ${DOMAIN} resolves to this server and port 80 is open,"
    warn "then re-run:  sudo certbot --webroot -w ${CERTBOT_WEBROOT} -d ${DOMAIN}"
    USE_SSL="no"
    PUBLIC_BASE_URL="http://$(hostname -I 2>/dev/null | awk '{print $1}')"
    # Keep the already-installed HTTP config; correct the app's base URL.
    sed -i "s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=${PUBLIC_BASE_URL}|" "${APP_DIR}/.env"
    systemctl restart ari-rtmp.service
  fi
fi

# ── Step 12: verify ────────────────────────────────────────────────────────
log "Verifying services"
sleep 2
systemctl --no-pager --quiet is-active postgresql && info "postgresql: active" || warn "postgresql: not active"
systemctl --no-pager --quiet is-active redis-server && info "redis-server: active" || warn "redis-server: not active"
systemctl --no-pager --quiet is-active nginx && info "nginx: active" || warn "nginx: not active"
systemctl --no-pager --quiet is-active ari-rtmp && info "ari-rtmp: active" || warn "ari-rtmp: not active"

# ── Done ───────────────────────────────────────────────────────────────────
if [[ "${USE_SSL}" == "yes" ]]; then
  RTMP_DISPLAY="rtmps://${DOMAIN}:1936/live   (or rtmp://${DOMAIN}:1935/live)"
else
  RTMP_DISPLAY="rtmp://${PUBLIC_BASE_URL#http://}:1935/live"
fi

echo
cat <<DONE
${C_GREEN}${C_BOLD}============================================================
 Ari RTMP installation complete
============================================================${C_RESET}

  Dashboard:        ${PUBLIC_BASE_URL}/
  First run:        open the dashboard to create the admin account
  RTMP ingest:      ${RTMP_DISPLAY}
  HLS output root:  ${HLS_ROOT}

  Next steps
  ----------
  1. Visit ${PUBLIC_BASE_URL}/ and complete the setup wizard.
  2. Create a stream, copy its key.
  3. In OBS → Settings → Stream:
        Service: Custom...
        Server:  ${RTMP_DISPLAY}
        Key:     <your stream key>
  4. Whitelist the domains allowed to embed the player.
  5. Embed:  <iframe src="${PUBLIC_BASE_URL}/player.html?key=<key>">

  Manage the service
  ------------------
    sudo systemctl status ari-rtmp
    sudo systemctl restart ari-rtmp
    sudo journalctl -u ari-rtmp -f
    sudo systemctl status nginx
    sudo ${NGINX_PREFIX}/sbin/nginx -t

DONE

if [[ "${USE_SSL}" == "yes" ]]; then
  echo -e "  SSL auto-renewal:  ${C_BOLD}sudo certbot renew --dry-run${C_RESET}"
  echo
fi
