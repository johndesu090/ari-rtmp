/**
 * Ari RTMP — API integration tests.
 *
 * Boots the real Express app against a live PostgreSQL + Redis (provided by
 * CI services or a local instance) and exercises the full surface: setup,
 * auth, streams, RTMP ingest validation, playback tokens + auto-refresh,
 * domain whitelisting, watermark/viewer logging, P2P config and edges.
 *
 * Run with:  npm test
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.PORT || '3100';
process.env.PORT = PORT;
process.env.NODE_ENV ||= 'test';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.SESSION_SECRET ||= 'test-session-secret';
process.env.INTERNAL_API_TOKEN ||= 'test-internal-token';
process.env.P2P_ENABLED ||= 'true';

const BASE = `http://127.0.0.1:${PORT}`;

// Boot the app (it listens on import).
const serverMod = await import('../src/server.js');
const { server } = serverMod;

async function waitHealthy() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error('server did not become healthy');
}
await waitHealthy();

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  const { redis } = await import('../src/lib/redis.js');
  const prisma = (await import('../src/lib/prisma.js')).default;
  try { redis.disconnect(); } catch { /* ignore */ }
  try { await prisma.$disconnect(); } catch { /* ignore */ }
});

// ── Helpers ────────────────────────────────────────────────────────────────
let cookie = '';

function captureCookie(res) {
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const kv = c.split(';')[0];
    if (kv.startsWith('ari_session=')) cookie = kv;
  }
}

async function api(method, path, { body, headers = {}, auth = false } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (auth && cookie) h['Cookie'] = cookie;
  const res = await fetch(BASE + path, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  let data = null;
  try { data = await res.json(); } catch { /* not json */ }
  return { res, data };
}

const ADMIN = { username: 'admin', password: 'supersecret123' };
let streamKey = '';
let playToken = '';
let watermark = '';
let edgeId = '';

// ── Health & setup ─────────────────────────────────────────────────────────
test('GET /api/health reports ok', async () => {
  const { res, data } = await api('GET', '/api/health');
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
});

test('setup status is unconfigured initially', async () => {
  const { res, data } = await api('GET', '/api/setup/status');
  assert.equal(res.status, 200);
  assert.equal(data.configured, false);
});

test('POST /api/setup creates the first admin', async () => {
  const { res, data } = await api('POST', '/api/setup', { body: ADMIN });
  assert.equal(res.status, 201);
  assert.equal(data.admin.username, ADMIN.username);
});

test('setup is now configured and rejects a second run', async () => {
  const status = await api('GET', '/api/setup/status');
  assert.equal(status.data.configured, true);
  const again = await api('POST', '/api/setup', { body: { username: 'someone', password: 'yyyyyyyyyy' } });
  assert.equal(again.res.status, 409);
});

// ── Auth ───────────────────────────────────────────────────────────────────
test('login rejects bad credentials', async () => {
  const { res } = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'wrong' } });
  assert.equal(res.status, 401);
});

test('login succeeds and sets a session cookie', async () => {
  const { res, data } = await api('POST', '/api/auth/login', { body: ADMIN });
  assert.equal(res.status, 200);
  captureCookie(res);
  assert.ok(cookie, 'expected an ari_session cookie');
  assert.equal(data.admin.username, ADMIN.username);
});

test('protected routes require auth', async () => {
  const { res } = await api('GET', '/api/streams');
  assert.equal(res.status, 401);
});

test('GET /api/auth/me returns the admin', async () => {
  const { res, data } = await api('GET', '/api/auth/me', { auth: true });
  assert.equal(res.status, 200);
  assert.equal(data.admin.username, ADMIN.username);
});

// ── Streams ────────────────────────────────────────────────────────────────
test('stream list starts empty', async () => {
  const { res, data } = await api('GET', '/api/streams', { auth: true });
  assert.equal(res.status, 200);
  assert.deepEqual(data.streams, []);
});

test('create a stream returns a key and ingest URLs', async () => {
  const { res, data } = await api('POST', '/api/streams', { auth: true, body: { title: 'Test' } });
  assert.equal(res.status, 201);
  assert.match(data.stream.streamKey, /^[a-f0-9]{32}$/);
  assert.ok(data.stream.rtmpUrl.includes('1935'));
  streamKey = data.stream.streamKey;
});

// ── RTMP ingest enforcement ────────────────────────────────────────────────
test('on_publish rejects an unknown stream key', async () => {
  const res = await fetch(`${BASE}/api/rtmp/on_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name: 'nope', addr: '127.0.0.1' }),
  });
  assert.equal(res.status, 403);
});

test('on_publish accepts a valid stream key', async () => {
  const res = await fetch(`${BASE}/api/rtmp/on_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name: streamKey, addr: '127.0.0.1' }),
  });
  assert.equal(res.status, 200);
});

test('disabling a stream blocks ingest', async () => {
  const list = await api('GET', '/api/streams', { auth: true });
  const id = list.data.streams[0].id;
  await api('PATCH', `/api/streams/${id}`, { auth: true, body: { isActive: false } });
  const res = await fetch(`${BASE}/api/rtmp/on_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name: streamKey, addr: '127.0.0.1' }),
  });
  assert.equal(res.status, 403);
  await api('PATCH', `/api/streams/${id}`, { auth: true, body: { isActive: true } });
});

// ── Playback tokens, watermark, viewer log ─────────────────────────────────
test('authorize issues a token, watermark and segment origins', async () => {
  const { res, data } = await api('POST', '/api/playback/authorize', {
    body: { streamKey, embedHost: '127.0.0.1' },
  });
  assert.equal(res.status, 200);
  assert.ok(data.token);
  assert.match(data.watermark, /^[A-Z2-9]{6}$/);
  assert.ok(Array.isArray(data.segmentOrigins));
  assert.ok(data.segmentOrigins.length >= 1);
  playToken = data.token;
  watermark = data.watermark;
});

test('refresh rotates the token and keeps the watermark', async () => {
  const { res, data } = await api('POST', '/api/playback/refresh', { body: { token: playToken } });
  assert.equal(res.status, 200);
  assert.ok(data.token);
  assert.notEqual(data.token, playToken);
  assert.equal(data.watermark, watermark);
  playToken = data.token;
});

test('verify gate accepts a valid token for the right stream', async () => {
  const res = await fetch(`${BASE}/api/playback/verify?token=${encodeURIComponent(playToken)}`, {
    method: 'POST',
    headers: {
      'X-Internal-Token': process.env.INTERNAL_API_TOKEN,
      'X-Original-URI': `/hls/${streamKey}/0/seg_001.ts?token=x`,
    },
  });
  assert.equal(res.status, 200);
});

test('verify gate rejects a token for a different stream', async () => {
  const res = await fetch(`${BASE}/api/playback/verify?token=${encodeURIComponent(playToken)}`, {
    method: 'POST',
    headers: {
      'X-Internal-Token': process.env.INTERNAL_API_TOKEN,
      'X-Original-URI': '/hls/deadbeef/0/seg_001.ts',
    },
  });
  assert.equal(res.status, 403);
});

test('verify gate rejects an invalid token', async () => {
  const res = await fetch(`${BASE}/api/playback/verify?token=bogus`, {
    method: 'POST',
    headers: { 'X-Internal-Token': process.env.INTERNAL_API_TOKEN },
  });
  assert.equal(res.status, 403);
});

test('verify gate also answers GET (nginx auth_request inherits the method)', async () => {
  const ok = await fetch(`${BASE}/api/playback/verify?token=${encodeURIComponent(playToken)}`, {
    method: 'GET',
    headers: {
      'X-Internal-Token': process.env.INTERNAL_API_TOKEN,
      'X-Original-URI': `/hls/${streamKey}/0/seg_001.ts`,
    },
  });
  assert.equal(ok.status, 200);

  const noToken = await fetch(`${BASE}/api/playback/verify`, {
    method: 'GET',
    headers: { 'X-Internal-Token': process.env.INTERNAL_API_TOKEN },
  });
  assert.equal(noToken.status, 403);
});

test('viewer log records the watermark ↔ IP relationship', async () => {
  const { res, data } = await api('GET', '/api/viewers', { auth: true });
  assert.equal(res.status, 200);
  const row = data.viewers.find((v) => v.watermark === watermark);
  assert.ok(row, 'expected the viewer session to be logged');
  assert.ok(row.ipAddress);
  assert.equal(row.stream.streamKey, streamKey);
});

// ── Domain whitelisting ────────────────────────────────────────────────────
test('adding a domain then enforcing it on authorize', async () => {
  const add = await api('POST', '/api/whitelist', { auth: true, body: { domain: 'example.com' } });
  assert.equal(add.res.status, 201);

  const blocked = await api('POST', '/api/playback/authorize', {
    body: { streamKey, embedHost: 'evil.com' },
  });
  assert.equal(blocked.res.status, 403);
  assert.equal(blocked.data.error, 'domain_not_whitelisted');

  const allowed = await api('POST', '/api/playback/authorize', {
    body: { streamKey, embedHost: 'player.example.com' },
  });
  assert.equal(allowed.res.status, 200);
});

test('check-domain mirrors the whitelist decision', async () => {
  const bad = await api('POST', '/api/playback/check-domain', { body: { host: 'evil.com' } });
  assert.equal(bad.data.allowed, false);
  const good = await api('POST', '/api/playback/check-domain', { body: { host: 'example.com' } });
  assert.equal(good.data.allowed, true);
});

// ── P2P config ─────────────────────────────────────────────────────────────
test('p2p config reports enabled with a tracker path', async () => {
  const { res, data } = await api('GET', '/api/p2p/config');
  assert.equal(res.status, 200);
  assert.equal(data.enabled, true);
  assert.equal(data.trackerPath, '/p2p');
});

// ── Edges / sub-servers ────────────────────────────────────────────────────
test('edge registration token can be generated', async () => {
  const initial = await api('GET', '/api/edges/registration-token', { auth: true });
  assert.equal(initial.res.status, 200);
  const gen = await api('POST', '/api/edges/registration-token', { auth: true });
  assert.match(gen.data.token, /^[a-f0-9]{48}$/);
});

test('an edge self-registers and reports a heartbeat', async () => {
  const token = (await api('GET', '/api/edges/registration-token', { auth: true })).data.token;
  const reg = await api('POST', '/api/edges/register', {
    body: { token, name: 'ci-edge', baseUrl: 'https://edge1.example.com', region: 'ci' },
  });
  assert.equal(reg.res.status, 200);
  assert.ok(reg.data.edgeId);
  assert.ok(reg.data.secret);
  edgeId = reg.data.edgeId;

  const hb = await api('POST', '/api/edges/heartbeat', {
    body: { edgeId, secret: reg.data.secret, loadPct: 12, version: 'ci' },
  });
  assert.equal(hb.res.status, 200);

  const bad = await api('POST', '/api/edges/heartbeat', {
    body: { edgeId, secret: 'wrong', loadPct: 1 },
  });
  assert.equal(bad.res.status, 403);
});

test('registration rejects a bad token', async () => {
  const reg = await api('POST', '/api/edges/register', {
    body: { token: 'not-the-token', name: 'x', baseUrl: 'https://x.example.com' },
  });
  assert.equal(reg.res.status, 403);
});

test('a healthy edge is added to the playback segment pool', async () => {
  const { data } = await api('POST', '/api/playback/authorize', {
    body: { streamKey, embedHost: 'example.com' },
  });
  const urls = data.segmentOrigins.map((o) => o.url);
  assert.ok(urls.includes('https://edge1.example.com'), `expected edge in pool, got ${urls}`);
});

test('edge list shows the registered edge as healthy', async () => {
  const { res, data } = await api('GET', '/api/edges', { auth: true });
  assert.equal(res.status, 200);
  const edge = data.edges.find((e) => e.id === edgeId);
  assert.ok(edge);
  assert.equal(edge.status, 'healthy');
});

test('an edge can be deleted', async () => {
  const del = await api('DELETE', `/api/edges/${edgeId}`, { auth: true });
  assert.equal(del.res.status, 200);
  const list = await api('GET', '/api/edges', { auth: true });
  assert.equal(list.data.edges.length, 0);
});
