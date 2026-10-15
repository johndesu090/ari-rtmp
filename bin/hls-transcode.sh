#!/usr/bin/env bash
# ── Ari RTMP — ABR → low-latency HLS transcoder ────────────────────────
# Invoked by nginx-rtmp `exec` with the stream key as $1. It reads the
# incoming RTMP stream and produces a 3-rung adaptive bitrate ladder as
# low-latency HLS (2s segments, 5-segment window).
#
# Rendered by install.sh (placeholders substituted):
#   __HLS_ROOT__        e.g. /var/www/hls
#   __RTMP_INGEST_URL__ e.g. rtmp://127.0.0.1:1935/live

set -euo pipefail

NAME="${1:-}"
if [[ -z "$NAME" ]]; then
    echo "hls-transcode: missing stream name" >&2
    exit 1
fi

HLS_ROOT="__HLS_ROOT__"
INGEST="__RTMP_INGEST_URL__"
OUT="${HLS_ROOT}/${NAME}"

# Clean any stale fragments from a previous session.
rm -rf "$OUT"
mkdir -p "$OUT/0" "$OUT/1" "$OUT/2"

# Segment/playlist tuning (low latency).
SEG_TIME=2
LIST_SIZE=5
GOP=48            # ~2s at 24fps source; adjust if your source differs

exec ffmpeg -hide_banner -loglevel warning -nostdin \
    -fflags +genpts \
    -i "${INGEST}/${NAME}" \
    -filter_complex "\
[0:v]split=3[v0][v1][v2]; \
[v0]scale=w=1920:h=1080:force_original_aspect_ratio=decrease[v0out]; \
[v1]scale=w=1280:h=720:force_original_aspect_ratio=decrease[v1out]; \
[v2]scale=w=854:h=480:force_original_aspect_ratio=decrease[v2out]" \
    -map "[v0out]" -map "[v1out]" -map "[v2out]" -map 0:a -map 0:a -map 0:a \
    -c:v:0 libx264 -preset veryfast -profile:v:0 high     -b:v:0 5000k -maxrate:v:0 5350k -bufsize:v:0 7500k \
    -c:v:1 libx264 -preset veryfast -profile:v:1 main     -b:v:1 2800k -maxrate:v:1 2996k -bufsize:v:1 4200k \
    -c:v:2 libx264 -preset veryfast -profile:v:2 baseline -b:v:2 1400k -maxrate:v:2 1498k -bufsize:v:2 2100k \
    -g "$GOP" -keyint_min "$GOP" -sc_threshold 0 \
    -c:a aac -b:a 128k -ac 2 -ar 48000 \
    -f hls \
    -hls_time "$SEG_TIME" \
    -hls_list_size "$LIST_SIZE" \
    -hls_flags delete_segments+independent_segments \
    -hls_segment_type mpegts \
    -hls_segment_filename "${OUT}/%v/seg_%03d.ts" \
    -master_pl_name index.m3u8 \
    -var_stream_map "v:0,a:0 v:1,a:1 v:2,a:2" \
    "${OUT}/%v/index.m3u8"
