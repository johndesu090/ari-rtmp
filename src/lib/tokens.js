import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import config from '../config.js';

// ── Playback tokens ────────────────────────────────────────────────────
// Short-lived tokens that gate HLS playlist/segment access via nginx
// `auth_request`. They carry a session id, the stream key and the watermark
// token — never the viewer's IP address.

export function issuePlaybackToken({ sessionId, streamKey, watermark, network, userAgentHash }) {
  const payload = {
    typ: 'play',
    sid: sessionId,
    sk: streamKey,
    wm: watermark,
  };
  // Bind the token to the client so it cannot be replayed elsewhere.
  if (network) payload.ip = network;
  if (userAgentHash) payload.ua = userAgentHash;

  return jwt.sign(
    payload,
    config.jwtSecret,
    {
      expiresIn: config.tokenTtlSeconds,
      issuer: 'ari-rtmp',
      jwtid: crypto.randomBytes(8).toString('hex'),
    },
  );
}

export function verifyPlaybackToken(token) {
  const payload = jwt.verify(token, config.jwtSecret, { issuer: 'ari-rtmp' });
  if (payload.typ !== 'play') {
    throw new Error('Unexpected token type');
  }
  return payload;
}

/**
 * Decode a playback token without enforcing expiry. Used by the refresh
 * endpoint so a player that just missed the deadline can still rotate.
 * The caller MUST bound the acceptable age itself.
 */
export function decodePlaybackTokenIgnoringExpiry(token) {
  const payload = jwt.verify(token, config.jwtSecret, {
    issuer: 'ari-rtmp',
    ignoreExpiration: true,
  });
  if (payload.typ !== 'play') {
    throw new Error('Unexpected token type');
  }
  return payload;
}

// ── Admin session tokens ───────────────────────────────────────────────
// Delivered as an httpOnly cookie for the dashboard.

export function issueAdminToken({ adminId, username }) {
  return jwt.sign(
    {
      typ: 'admin',
      sub: adminId,
      username,
    },
    config.sessionSecret,
    {
      expiresIn: `${config.adminSessionHours}h`,
      issuer: 'ari-rtmp',
      jwtid: crypto.randomBytes(8).toString('hex'),
    },
  );
}

export function verifyAdminToken(token) {
  const payload = jwt.verify(token, config.sessionSecret, { issuer: 'ari-rtmp' });
  if (payload.typ !== 'admin') {
    throw new Error('Unexpected token type');
  }
  return payload;
}

export const adminCookieName = 'ari_session';

export function adminCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd && config.publicBaseUrl.startsWith('https'),
    maxAge: config.adminSessionHours * 60 * 60 * 1000,
    path: '/',
  };
}

// ── Playback cookie (native-HLS fallback) ──────────────────────────────
// hls.js attaches the token to every request via xhrSetup, but Safari/iOS
// use the native HLS player which cannot rewrite URLs. For those clients we
// also drop the token in a short-lived cookie scoped to /hls/.
export const playbackCookieName = 'ari_play';

export function playbackCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd && config.publicBaseUrl.startsWith('https'),
    maxAge: config.tokenTtlSeconds * 1000,
    path: '/hls',
  };
}
