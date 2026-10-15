# ── Ari RTMP — edge / sub-server image ─────────────────────────────────
# A caching Nginx relay that pulls HLS from the origin and validates every
# request against the origin, plus a registration + heartbeat loop.
FROM nginx:1.27-alpine

RUN apk add --no-cache curl jq bash

COPY nginx/edge-http.conf.template nginx/edge-ssl.conf.template /opt/templates/
COPY docker/edge/entrypoint.sh /opt/entrypoint.sh
COPY docker/edge/heartbeat.sh /opt/heartbeat.sh
RUN chmod +x /opt/entrypoint.sh /opt/heartbeat.sh \
    && mkdir -p /var/cache/nginx/ari /var/www/certbot /etc/ari-edge

EXPOSE 80 443

ENTRYPOINT ["/opt/entrypoint.sh"]
