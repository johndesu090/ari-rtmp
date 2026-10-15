import Redis from 'ioredis';
import config from '../config.js';

// Single shared Redis connection. Used for live-stream state, short-lived
// playback sessions and rate-limit counters. If Redis is unavailable we keep
// the process alive and degrade gracefully (DB remains source of truth).
const globalForRedis = globalThis;

export const redis =
  globalForRedis.__ariRedis ||
  new Redis(config.redisUrl, {
    lazyConnect: false,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    retryStrategy(times) {
      // Back off up to 2s between reconnect attempts.
      return Math.min(times * 200, 2000);
    },
  });

redis.on('error', (err) => {
  // Don't crash the process on transient Redis errors.
  console.error('[redis] error:', err.message);
});

if (process.env.NODE_ENV !== 'production') {
  globalForRedis.__ariRedis = redis;
}

export function redisReady() {
  return redis.status === 'ready';
}

// ── Live stream state ──────────────────────────────────────────────────
const liveKey = (streamKey) => `live:${streamKey}`;

export async function markLive(streamKey, addr) {
  if (!redisReady()) return;
  try {
    await redis.set(liveKey(streamKey), addr || '1', 'EX', 60 * 60 * 12);
  } catch (err) {
    console.error('[redis] markLive failed:', err.message);
  }
}

export async function markOffline(streamKey) {
  if (!redisReady()) return;
  try {
    await redis.del(liveKey(streamKey));
  } catch (err) {
    console.error('[redis] markOffline failed:', err.message);
  }
}

export async function isLive(streamKey) {
  if (!redisReady()) return false;
  try {
    return (await redis.exists(liveKey(streamKey))) === 1;
  } catch {
    return false;
  }
}

// ── Playback session cache (watermark lookup) ──────────────────────────
const sessionKey = (sessionId) => `play:${sessionId}`;

export async function cachePlaybackSession(sessionId, data, ttlSeconds) {
  if (!redisReady()) return;
  try {
    await redis.set(sessionKey(sessionId), JSON.stringify(data), 'EX', ttlSeconds);
  } catch (err) {
    console.error('[redis] cachePlaybackSession failed:', err.message);
  }
}

export async function getPlaybackSession(sessionId) {
  if (!redisReady()) return null;
  try {
    const raw = await redis.get(sessionKey(sessionId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function touchPlaybackSession(sessionId, ttlSeconds) {
  if (!redisReady()) return;
  try {
    await redis.expire(sessionKey(sessionId), ttlSeconds);
  } catch {
    /* ignore */
  }
}

export default redis;
