#!/bin/sh
# Ari RTMP app entrypoint: wait for the database, sync the schema, start the API.
set -e

echo "[app] synchronising database schema..."
n=0
until npx prisma db push --skip-generate >/tmp/prisma-push.log 2>&1; do
  n=$((n + 1))
  echo "[app] database not ready (attempt ${n}); retrying in 2s..."
  tail -n 3 /tmp/prisma-push.log 2>/dev/null || true
  sleep 2
done
echo "[app] database ready."

exec node src/server.js
