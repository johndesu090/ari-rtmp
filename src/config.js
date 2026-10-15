import 'dotenv/config';

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// P2P ICE servers: accept a JSON array or a comma-separated STUN/TURN list.
function parseIceServers() {
  const raw = process.env.P2P_ICE_SERVERS;
  if (!raw) {
    return [
      {
        urls: [
          'stun:stun.l.google.com:19302',
          'stun:global.stun.twilio.com:3478',
        ],
      },
    ];
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch {
    /* fall through to comma-separated parsing */
  }
  const urls = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return urls.length ? [{ urls }] : [];
}

const config = {
  env: process.env.NODE_ENV || 'development',
  host: process.env.HOST || '127.0.0.1',
  port: parseInt(process.env.PORT || '3000', 10),

  publicBaseUrl: (process.env.PUBLIC_BASE_URL || 'http://localhost').replace(/\/+$/, ''),

  // Host advertised for RTMP/RTMPS ingest. Set this when the public hostname
  // is behind a CDN/proxy that does not forward ports 1935/1936 (e.g. a
  // Cloudflare-proxied domain) — use a DNS-only hostname or the origin IP.
  ingestHost: process.env.INGEST_HOST ? String(process.env.INGEST_HOST).trim() : null,

  jwtSecret: required('JWT_SECRET'),
  sessionSecret: required('SESSION_SECRET'),

  databaseUrl: required('DATABASE_URL'),
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',

  tokenTtlSeconds: parseInt(process.env.TOKEN_TTL_SECONDS || '30', 10),
  adminSessionHours: parseInt(process.env.ADMIN_SESSION_HOURS || '24', 10),

  hlsRoot: process.env.HLS_ROOT || '/var/www/hls',
  rtmpIngestUrl: process.env.RTMP_INGEST_URL || 'rtmp://127.0.0.1:1935/live',

  // ── Peer-to-peer segment sharing (SwarmCloud-style P2P-CDN) ──────────
  p2p: {
    enabled: (process.env.P2P_ENABLED || 'true') !== 'false',
    maxPeers: parseInt(process.env.P2P_MAX_PEERS || '5', 10),
    maxSwarmPeers: parseInt(process.env.P2P_MAX_SWARM_PEERS || '200', 10),
    iceServers: parseIceServers(),
    snapshotSeconds: parseInt(process.env.P2P_SNAPSHOT_SECONDS || '30', 10),
  },

  isProd: (process.env.NODE_ENV || 'development') === 'production',
};

export default config;
