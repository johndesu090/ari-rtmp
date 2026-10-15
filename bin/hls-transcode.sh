#!/usr/bin/env bash
# ── Ari RTMP — ABR → low-latency HLS transcoder ────────────────────────
# Invoked by nginx-rtmp `exec` with the stream key as $1. It reads the
# incoming RTMP stream and produces a 3-rung adaptive bitrate ladder as
# low-latency HLS (2s segments, 5-segment window).
#
# The ladder never upscales: the top rung is capped at the source height and
# the lower rungs scale down from it, so a 480p ingest is not re-encoded at
# 1080p (which is wasteful and can fall behind realtime on small servers).
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

# Log ffmpeg/errors somewhere readable. Falls back to stderr (nginx error log).
LOG_DIR="/var/log/ari-rtmp"
if mkdir -p "$LOG_DIR" 2>/dev/null && [ -w "$LOG_DIR" ]; then
  LOG="${LOG_DIR}/${NAME}.log"
else
  LOG="/dev/stderr"
fi
{
  echo "==== hls-transcode start $(date -Is) name=${NAME} hls_root=${HLS_ROOT} ingest=${INGEST} ===="
} >>"$LOG" 2>/dev/null || true

# Clean any stale fragments from a previous session.
rm -rf "$OUT"
mkdir -p "$OUT/0" "$OUT/1" "$OUT/2"

SEG_TIME=2
LIST_SIZE=5
GOP=48            # ~2s at 24fps source; adjust if your source differs

# ── Probe the source (audio presence + video height) ───────────────────
SRC_H=720
HAS_AUDIO=1
if command -v ffprobe >/dev/null 2>&1; then
  H="$(timeout 12 ffprobe -v error -select_streams v:0 \
        -show_entries stream=height -of csv=p=0 "${INGEST}/${NAME}" 2>/dev/null | head -n1 || true)"
  if [[ "$H" =~ ^[0-9]+$ ]] && (( H > 0 )); then
    SRC_H="$H"
  fi
  if AUDIO_PROBE="$(timeout 12 ffprobe -v error -select_streams a \
        -show_entries stream=codec_type -of csv=p=0 "${INGEST}/${NAME}" 2>/dev/null)"; then
    printf '%s' "$AUDIO_PROBE" | grep -q audio || HAS_AUDIO=0
  fi
fi

even() { local v="$1"; (( v % 2 == 0 )) && echo "$v" || echo $(( v - 1 )); }

# Ladder heights: never exceed the source; 3 rungs (top, ~2/3, ~1/2).
TOP=$(( SRC_H < 1080 ? SRC_H : 1080 ))
R0="$(even "$TOP")"
R1="$(even $(( TOP * 2 / 3 > 240 ? TOP * 2 / 3 : 240 )))"
R2="$(even $(( TOP / 2 > 240 ? TOP / 2 : 240 )))"

rate_for() {
  local h="$1"
  if   (( h >= 1080 )); then echo 5000
  elif (( h >= 720  )); then echo 2800
  elif (( h >= 480  )); then echo 1400
  elif (( h >= 360  )); then echo 1000
  elif (( h >= 240  )); then echo 700
  else echo 500
  fi
}
B0="$(rate_for "$R0")"; B1="$(rate_for "$R1")"; B2="$(rate_for "$R2")"
MAX0=$(( B0 * 107 / 100 )); BUF0=$(( B0 * 15 / 10 ))
MAX1=$(( B1 * 107 / 100 )); BUF1=$(( B1 * 15 / 10 ))
MAX2=$(( B2 * 107 / 100 )); BUF2=$(( B2 * 15 / 10 ))

echo "hls-transcode: source=${SRC_H}p audio=${HAS_AUDIO} ladder=${R0}p/${R1}p/${R2}p" >>"$LOG" 2>/dev/null || true

INPUT_ARGS=(-i "${INGEST}/${NAME}")
AUDIO_MAP=(-map 0:a -map 0:a -map 0:a)
if [[ "$HAS_AUDIO" != "1" ]]; then
  echo "hls-transcode: no audio track detected for ${NAME}; using silent audio" >>"$LOG" 2>/dev/null || true
  INPUT_ARGS+=(-f lavfi -i "anullsrc=channel_layout=stereo:sample_rate=48000")
  AUDIO_MAP=(-map 1:a -map 1:a -map 1:a)
fi

exec ffmpeg -hide_banner -loglevel warning -nostdin \
    -fflags +genpts \
    "${INPUT_ARGS[@]}" \
    -filter_complex "\
[0:v]split=3[v0][v1][v2]; \
[v0]scale=-2:${R0}[v0out]; \
[v1]scale=-2:${R1}[v1out]; \
[v2]scale=-2:${R2}[v2out]" \
    -map "[v0out]" -map "[v1out]" -map "[v2out]" \
    "${AUDIO_MAP[@]}" \
    -c:v:0 libx264 -preset veryfast -profile:v:0 high     -b:v:0 "${B0}k" -maxrate:v:0 "${MAX0}k" -bufsize:v:0 "${BUF0}k" \
    -c:v:1 libx264 -preset veryfast -profile:v:1 main     -b:v:1 "${B1}k" -maxrate:v:1 "${MAX1}k" -bufsize:v:1 "${BUF1}k" \
    -c:v:2 libx264 -preset veryfast -profile:v:2 baseline -b:v:2 "${B2}k" -maxrate:v:2 "${MAX2}k" -bufsize:v:2 "${BUF2}k" \
    -g "$GOP" -keyint_min "$GOP" -sc_threshold 0 \
    -c:a aac -b:a 128k -ac 2 -ar 48000 \
    -f hls \
    -hls_time "$SEG_TIME" \
    -hls_list_size "$LIST_SIZE" \
    -strftime 1 \
    -hls_flags delete_segments+independent_segments+second_level_segment_index \
    -hls_segment_type mpegts \
    -hls_segment_filename "${OUT}/%v/seg_%Y%m%d-%H%M%S-%%03d.ts" \
    -master_pl_name index.m3u8 \
    -var_stream_map "v:0,a:0 v:1,a:1 v:2,a:2" \
    "${OUT}/%v/index.m3u8" 2>>"$LOG"
