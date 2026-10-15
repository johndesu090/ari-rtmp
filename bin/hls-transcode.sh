#!/usr/bin/env bash
# ── Ari RTMP — ABR → low-latency HLS transcoder ────────────────────────
# Invoked by nginx-rtmp `exec` with the stream key as $1. It reads the
# incoming RTMP stream and produces a 3-rung adaptive bitrate ladder as
# low-latency HLS (2s segments, 5-segment window).
#
# The two paths below are substituted at install time (by install.sh or the
# Docker entrypoint) from HLS_ROOT and the internal RTMP ingest URL.

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

# Detect whether the source has an audio track. If it does not, generate a
# silent one so the ABR ladder (and the audio/video variant pairing) still
# works — otherwise ffmpeg aborts with "Stream map '0:a' matches no streams".
HAS_AUDIO=1
if command -v ffprobe >/dev/null 2>&1; then
  if AUDIO_PROBE="$(timeout 12 ffprobe -v error -select_streams a \
        -show_entries stream=codec_type -of csv=p=0 "${INGEST}/${NAME}" 2>/dev/null)"; then
    if ! printf '%s' "$AUDIO_PROBE" | grep -q audio; then
      HAS_AUDIO=0
    fi
  else
    # ffprobe failed (stream not ready yet) — assume audio is present.
    HAS_AUDIO=1
  fi
fi

INPUT_ARGS=(-i "${INGEST}/${NAME}")
AUDIO_MAP=(-map 0:a -map 0:a -map 0:a)
if [[ "$HAS_AUDIO" != "1" ]]; then
  echo "hls-transcode: no audio track detected for ${NAME}; using silent audio" >&2
  INPUT_ARGS+=(-f lavfi -i "anullsrc=channel_layout=stereo:sample_rate=48000")
  AUDIO_MAP=(-map 1:a -map 1:a -map 1:a)
fi

exec ffmpeg -hide_banner -loglevel warning -nostdin \
    -fflags +genpts \
    "${INPUT_ARGS[@]}" \
    -filter_complex "\
[0:v]split=3[v0][v1][v2]; \
[v0]scale=w=1920:h=1080:force_original_aspect_ratio=decrease[v0out]; \
[v1]scale=w=1280:h=720:force_original_aspect_ratio=decrease[v1out]; \
[v2]scale=w=854:h=480:force_original_aspect_ratio=decrease[v2out]" \
    -map "[v0out]" -map "[v1out]" -map "[v2out]" \
    "${AUDIO_MAP[@]}" \
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
