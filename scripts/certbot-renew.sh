#!/usr/bin/env bash
# ── Ari RTMP — Certbot renewal hook ────────────────────────────────────
# Called by the systemd timer. Renews Let's Encrypt certificates and
# reloads the source-built Nginx on success.

set -euo pipefail

if ! command -v certbot >/dev/null 2>&1; then
    echo "certbot not installed; nothing to renew." >&2
    exit 0
fi

certbot renew --quiet --no-random-sleep-on-renew \
    --deploy-hook "/usr/local/nginx/sbin/nginx -s reload"

echo "certbot renew completed at $(date -Is)"
