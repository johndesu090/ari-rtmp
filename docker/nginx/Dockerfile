# ── Ari RTMP — origin Nginx image (HTTP/HTTPS + RTMP/RTMPS + HLS + ABR) ─
# Builds Nginx from source with nginx-rtmp-module, then renders its config
# from the repo templates at container start.

# ── Build stage ────────────────────────────────────────────────────────
FROM debian:bookworm-slim AS build

ARG NGINX_VERSION=1.26.2
ARG RTMP_VERSION=v1.2.2

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       build-essential libpcre3-dev libssl-dev zlib1g-dev \
       ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN curl -fsSLO "https://nginx.org/download/nginx-${NGINX_VERSION}.tar.gz" \
    && tar -xzf "nginx-${NGINX_VERSION}.tar.gz" \
    && git clone --depth 1 --branch "${RTMP_VERSION}" https://github.com/arut/nginx-rtmp-module.git

WORKDIR /src/nginx-${NGINX_VERSION}
RUN ./configure \
      --prefix=/usr/local/nginx \
      --with-http_ssl_module \
      --with-http_v2_module \
      --with-http_realip_module \
      --with-http_auth_request_module \
      --with-http_stub_status_module \
      --with-http_secure_link_module \
      --with-http_gzip_static_module \
      --with-stream \
      --with-stream_ssl_module \
      --with-threads \
      --add-module=/src/nginx-rtmp-module \
    && make -j"$(nproc)" \
    && make install

# ── Runtime stage ──────────────────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ffmpeg libssl3 libpcre3 zlib1g ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && (getent group www-data >/dev/null || groupadd -r www-data) \
    && (id -u www-data >/dev/null 2>&1 || useradd -r -g www-data -d /var/www -s /usr/sbin/nologin www-data) \
    && mkdir -p /var/www/hls /var/www/certbot /var/log/nginx /run

COPY --from=build /usr/local/nginx /usr/local/nginx

# Templates (rendered at start) + transcode script template.
COPY nginx /opt/templates
COPY bin/hls-transcode.sh /opt/templates/hls-transcode.sh
COPY docker/nginx/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 80 443 1935 1936

ENTRYPOINT ["/entrypoint.sh"]
