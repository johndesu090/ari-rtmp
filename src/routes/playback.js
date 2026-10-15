import express from 'express';
import prisma from '../lib/prisma.js';
import config from '../config.js';
import { uniqueWatermark } from '../lib/watermark.js';
import {
  issuePlaybackToken,
  verifyPlaybackToken,
  decodePlaybackTokenIgnoringExpiry,
  playbackCookieName,
  playbackCookieOptions,
} from '../lib/tokens.js';
import { clientIp, clientNetwork, normalizeHost, hostMatchesWhitelist, userAgentHash, isScraperUserAgent } from '../lib/util.js';
import { getEdgePool } from '../lib/edges.js';
import {
  cachePlaybackSession,
  getPlaybackSession,
  touchPlaybackSession,
} from '../lib/redis.js';
import { requireInternal } from '../middleware/auth.js';

const router = express.Router();

// Refresh the token when 75% of its lifetime has elapsed.
const refreshInSeconds = Math.max(5, Math.floor(config.tokenTtlSeconds * 0.75));

// Origin first (always available, low weight), then healthy edges.
async function buildSegmentOrigins() {
  const origin = { url: config.publicBaseUrl, weight: 1, region: null };
  try {
    const edges = await getEdgePool();
    return [origin, ...edges];
  } catch {
    return [origin];
  }
}

// Collect every candidate embedding host. The player sends the referrer and
// ancestor origins (a nested srcdoc iframe can make the referrer an empty
// "about:" URL); we also fall back to Origin/Referer headers.
function resolveEmbedHosts(req) {
  const hosts = [];
  const add = (value) => {
    const h = normalizeHost(value);
    if (h && !hosts.includes(h)) hosts.push(h);
  };
  if (Array.isArray(req.body?.embedHosts)) req.body.embedHosts.forEach(add);
  add(req.body?.embedHost);
  add(req.headers.origin);
  add(req.headers.referer);
  return hosts;
}

async function isEmbedAllowed(hosts) {
  const ownHost = normalizeHost(config.publicBaseUrl);

  // Same-origin (direct visit) is always allowed.
  if (hosts.some((h) => h === ownHost)) return true;

  const approved = await prisma.whitelistedDomain.findMany({ select: { domain: true } });

  // No whitelist configured → no embed restriction.
  if (approved.length === 0) return true;

  // A whitelist is active: an unknown embedding origin is denied.
  if (hosts.length === 0) return false;

  const domains = approved.map((d) => d.domain);
  return hosts.some((h) => hostMatchesWhitelist(h, domains));
}

function hlsUrlFor(streamKey) {
  return `${config.publicBaseUrl}/hls/${streamKey}/index.m3u8`;
}

// ── Client-side embed-domain pre-check ─────────────────────────────────
// The player calls this with the host it is embedded on. It is advisory
// only — /authorize performs the authoritative check.
// POST /api/playback/check-domain  { host }
router.post('/check-domain', async (req, res) => {
  const hosts = [];
  const add = (v) => {
    const h = normalizeHost(v);
    if (h && !hosts.includes(h)) hosts.push(h);
  };
  if (Array.isArray(req.body?.hosts)) req.body.hosts.forEach(add);
  add(req.body?.host);
  try {
    const allowed = await isEmbedAllowed(hosts);
    return res.json({ allowed, hosts, host: hosts[0] || '' });
  } catch (err) {
    console.error('[playback] check-domain failed:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── Authorize a new playback session ───────────────────────────────────
// POST /api/playback/authorize  { streamKey, embedHost }
router.post('/authorize', async (req, res) => {
  const streamKey = String(req.body?.streamKey || '').trim();
  if (!streamKey) {
    return res.status(400).json({ error: 'stream_key_required' });
  }

  try {
    const stream = await prisma.stream.findUnique({ where: { streamKey } });
    if (!stream || !stream.isActive) {
      return res.status(403).json({ error: 'stream_unavailable' });
    }

    const embedHosts = resolveEmbedHosts(req);
    if (!(await isEmbedAllowed(embedHosts))) {
      return res.status(403).json({
        error: 'domain_not_whitelisted',
        embedHost: embedHosts[0] || '',
        embedHosts,
      });
    }

    const ip = clientIp(req);
    const networkKey = clientNetwork(ip);
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 512);

    if (isScraperUserAgent(req.headers['user-agent'])) {
      return res.status(403).json({ error: 'client_not_allowed' });
    }

    // One stable watermark per viewer network. Reuse the session for this
    // network key (or, for rows created before networkKey existed, the exact
    // IP); otherwise create a new session with a fresh watermark.
    let session = await prisma.viewerSession.findFirst({
      where: { networkKey },
      orderBy: { lastSeen: 'desc' },
    });
    if (!session) {
      session = await prisma.viewerSession.findFirst({
        where: { ipAddress: ip },
        orderBy: { lastSeen: 'desc' },
      });
    }

    if (session) {
      session = await prisma.viewerSession.update({
        where: { id: session.id },
        data: { streamId: stream.id, userAgent, lastSeen: new Date(), ipAddress: ip, networkKey },
      });
    } else {
      const newWatermark = await uniqueWatermark();
      session = await prisma.viewerSession.create({
        data: { watermark: newWatermark, ipAddress: ip, networkKey, userAgent, streamId: stream.id },
      });
    }

    const watermark = session.watermark;
    const token = issuePlaybackToken({
      sessionId: session.id,
      streamKey,
      watermark,
      network: networkKey,
      userAgentHash: userAgentHash(req.headers['user-agent']),
    });

    await cachePlaybackSession(
      session.id,
      { watermark, streamKey, streamId: stream.id },
      config.tokenTtlSeconds * 4,
    );

    // Cookie fallback for the native HLS player (Safari/iOS).
    res.cookie(playbackCookieName, token, playbackCookieOptions());

    return res.json({
      token,
      watermark,
      hlsUrl: hlsUrlFor(streamKey),
      expiresIn: config.tokenTtlSeconds,
      refreshIn: refreshInSeconds,
      segmentOrigins: await buildSegmentOrigins(),
    });
  } catch (err) {
    console.error('[playback] authorize failed:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── Rotate the playback token before expiry ────────────────────────────
// POST /api/playback/refresh  { token }
router.post('/refresh', async (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (!token) return res.status(400).json({ error: 'token_required' });

  let payload;
  try {
    payload = decodePlaybackTokenIgnoringExpiry(token);
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }

  // Bound the grace window: only rotate tokens that are at most one TTL
  // past expiry.
  const now = Math.floor(Date.now() / 1000);
  const maxAge = config.tokenTtlSeconds * 2;
  if (payload.iat && now - payload.iat > maxAge) {
    return res.status(401).json({ error: 'token_too_old' });
  }

  // The refresh caller must be the same client the token was issued to —
  // otherwise a stolen token could be re-bound to an attacker's UA/IP.
  const reqNetwork = clientNetwork(clientIp(req));
  const reqUaHash = userAgentHash(req.headers['user-agent']);
  if (isScraperUserAgent(req.headers['user-agent'])) {
    return res.status(403).json({ error: 'client_not_allowed' });
  }
  if ((payload.ua && payload.ua !== reqUaHash) || (payload.ip && payload.ip !== reqNetwork)) {
    return res.status(403).json({ error: 'client_mismatch' });
  }

  try {
    // Confirm the session still exists and the stream is still active.
    const session = await prisma.viewerSession.findUnique({
      where: { id: payload.sid },
      include: { stream: { select: { streamKey: true, isActive: true } } },
    });

    if (!session || session.stream.streamKey !== payload.sk) {
      return res.status(401).json({ error: 'session_expired' });
    }
    if (!session.stream.isActive) {
      return res.status(403).json({ error: 'stream_unavailable' });
    }

    await prisma.viewerSession.update({
      where: { id: session.id },
      data: { lastSeen: new Date() },
    });
    await touchPlaybackSession(session.id, config.tokenTtlSeconds * 4);

    const newToken = issuePlaybackToken({
      sessionId: session.id,
      streamKey: payload.sk,
      watermark: session.watermark,
      network: payload.ip || reqNetwork,
      userAgentHash: payload.ua || reqUaHash,
    });

    res.cookie(playbackCookieName, newToken, playbackCookieOptions());

    return res.json({
      token: newToken,
      watermark: session.watermark,
      expiresIn: config.tokenTtlSeconds,
      refreshIn: refreshInSeconds,
      segmentOrigins: await buildSegmentOrigins(),
    });
  } catch (err) {
    console.error('[playback] refresh failed:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── nginx auth_request gate for /hls/ ──────────────────────────────────
// POST /api/playback/verify?token=...   (X-Original-URI = /hls/<key>/...)
// Used by the origin's own nginx (shared-secret protected).
async function handleVerify(req, res) {
  // nginx auth_request subrequests do not inherit $args, so the token is
  // forwarded in the X-Play-Token header (extracted from $request_uri);
  // the query string is still accepted for direct calls.
  const token = String(
    req.headers['x-play-token'] ||
      req.query.token ||
      req.body?.token ||
      req.cookies?.[playbackCookieName] ||
      '',
  ).trim();
  if (!token) return res.status(403).send('no token');

  let payload;
  try {
    payload = verifyPlaybackToken(token);
  } catch {
    return res.status(403).send('invalid token');
  }

  // The token is bound to the client that requested it (IP network + UA).
  // This is what stops a scraped token being replayed by ffmpeg/yt-dlp.
  if (isScraperUserAgent(req.headers['user-agent'])) {
    return res.status(403).send('client not allowed');
  }
  if (
    (payload.ua && payload.ua !== userAgentHash(req.headers['user-agent'])) ||
    (payload.ip && payload.ip !== clientNetwork(clientIp(req)))
  ) {
    return res.status(403).send('client mismatch');
  }

  const originalUri = String(req.headers['x-original-uri'] || '');
  const m = originalUri.match(/^\/hls\/([^/]+)\//);
  if (m) {
    const requestedKey = decodeURIComponent(m[1]);
    if (requestedKey !== payload.sk) {
      return res.status(403).send('token/stream mismatch');
    }
  }

  // Ensure the stream is still active.
  try {
    const stream = await prisma.stream.findUnique({
      where: { streamKey: payload.sk },
      select: { isActive: true },
    });
    if (!stream || !stream.isActive) {
      return res.status(403).send('stream unavailable');
    }
  } catch {
    return res.status(500).send('verify error');
  }

  return res.status(200).send('ok');
}

// nginx `auth_request` subrequests inherit the original request method, so
// the gate must answer GET as well as POST.
router.get('/verify', requireInternal, handleVerify);
router.post('/verify', requireInternal, handleVerify);

// Public gate used by edge/sub-servers (protected by the playback token
// itself; the edge forwards the viewer's token to the origin).
router.get('/verify-edge', handleVerify);
router.post('/verify-edge', handleVerify);

// Lightweight session info (used for debugging / dashboard embedding).
router.get('/session/:id', requireInternal, async (req, res) => {
  const cached = await getPlaybackSession(req.params.id);
  if (!cached) return res.status(404).json({ error: 'not_found' });
  res.json({ session: cached });
});

export default router;
