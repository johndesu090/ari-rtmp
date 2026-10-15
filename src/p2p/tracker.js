import { WebSocketServer } from 'ws';
import crypto from 'node:crypto';
import config from '../config.js';
import prisma from '../lib/prisma.js';
import { verifyPlaybackToken } from '../lib/tokens.js';

// ============================================================================
//  Ari RTMP — P2P signaling tracker (SwarmCloud-style P2P-CDN)
//
//  Viewers of the same stream form a "swarm". Peers open WebRTC data
//  channels to a few neighbours and exchange HLS segments directly, so the
//  origin server serves fewer bytes. This module is the tracker/signaling
//  server plus the live-stats collector behind the dashboard.
//
//  Access is gated: a peer must present a valid short-lived playback token
//  to join a swarm (see /api/playback/authorize).
// ============================================================================

const HOLDER_LIMIT = 4000; // max segments indexed per swarm
const MAX_HOLDERS_RETURNED = 6;

/** @type {Map<string, Swarm>} */
const swarms = new Map();

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

function getSwarm(key) {
  let s = swarms.get(key);
  if (!s) {
    s = {
      key,
      peers: new Map(), // peerId -> Peer
      holders: new Map(), // segKey -> Set<peerId>
      p2pBytes: 0,
      serverBytes: 0,
      pending: { p2p: 0, server: 0 },
    };
    swarms.set(key, s);
  }
  return s;
}

function addHolder(swarm, seg, pid) {
  let set = swarm.holders.get(seg);
  if (!set) {
    set = new Set();
    swarm.holders.set(seg, set);
  }
  set.add(pid);
  // Bound memory: drop the oldest indexed segments when the cap is hit.
  while (swarm.holders.size > HOLDER_LIMIT) {
    const oldest = swarm.holders.keys().next().value;
    swarm.holders.delete(oldest);
  }
}

function removeHolder(swarm, seg, pid) {
  const set = swarm.holders.get(seg);
  if (set) {
    set.delete(pid);
    if (set.size === 0) swarm.holders.delete(seg);
  }
}

function pickNeighbours(swarm, excludeId, n) {
  const ids = [];
  for (const id of swarm.peers.keys()) {
    if (id !== excludeId) ids.push(id);
  }
  // Shuffle a copy and take n.
  for (let i = ids.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids.slice(0, n);
}

function broadcast(swarm, msg, exceptId) {
  const payload = JSON.stringify(msg);
  for (const [id, peer] of swarm.peers) {
    if (id === exceptId) continue;
    if (peer.ws.readyState === peer.ws.OPEN) {
      try {
        peer.ws.send(payload);
      } catch {
        /* ignore */
      }
    }
  }
}

function removePeer(peer) {
  if (!peer || peer.removed) return;
  peer.removed = true;
  const swarm = swarms.get(peer.key);
  if (!swarm) return;
  swarm.peers.delete(peer.id);
  for (const seg of peer.segments) removeHolder(swarm, seg, peer.id);
  broadcast(swarm, { t: 'peer-left', id: peer.id }, peer.id);
  if (swarm.peers.size === 0 && swarm.pending.p2p === 0 && swarm.pending.server === 0) {
    swarms.delete(peer.key);
  }
}

// ── Message handling ───────────────────────────────────────────────────
function handleMessage(peer, raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (!msg || typeof msg.t !== 'string') return;

  // The only message allowed before a successful join.
  if (!peer.joined && msg.t !== 'join') return;

  switch (msg.t) {
    case 'join':
      return handleJoin(peer, msg);
    case 'reauth':
      return handleReauth(peer, msg);
    case 'have':
      return handleHave(peer, msg);
    case 'who':
      return handleWho(peer, msg);
    case 'signal':
      return handleSignal(peer, msg);
    case 'stats':
      return handleStats(peer, msg);
    default:
      return undefined;
  }
}

function handleJoin(peer, msg) {
  if (peer.joined) return undefined;
  const key = String(msg.key || '').trim();
  const token = String(msg.token || '').trim();
  if (!key || !token) return peer.ws.close(4001, 'missing key or token');

  let payload;
  try {
    payload = verifyPlaybackToken(token);
  } catch {
    return peer.ws.close(4003, 'invalid token');
  }
  if (payload.sk !== key) return peer.ws.close(4003, 'token/stream mismatch');

  const swarm = getSwarm(key);
  if (swarm.peers.size >= config.p2p.maxSwarmPeers) {
    return peer.ws.close(4029, 'swarm full');
  }

  peer.id = newId();
  peer.key = key;
  peer.token = token;
  peer.joined = true;
  peer.joinedAt = Date.now();
  swarm.peers.set(peer.id, peer);

  const neighbours = pickNeighbours(swarm, peer.id, config.p2p.maxPeers);

  send(peer, {
    t: 'joined',
    id: peer.id,
    iceServers: config.p2p.iceServers,
    maxPeers: config.p2p.maxPeers,
    peers: neighbours,
  });

  // Let existing peers know a new peer arrived (they do not initiate;
  // the newcomer initiates connections to the returned neighbours).
  broadcast(swarm, { t: 'peer-joined', id: peer.id }, peer.id);
  return undefined;
}

function handleReauth(peer, msg) {
  const token = String(msg.token || '').trim();
  if (!token) return;
  try {
    const payload = verifyPlaybackToken(token);
    if (payload.sk !== peer.key) throw new Error('mismatch');
    peer.token = token;
  } catch {
    peer.ws.close(4003, 'reauth failed');
  }
}

function handleHave(peer, msg) {
  const swarm = swarms.get(peer.key);
  if (!swarm) return;
  const segs = Array.isArray(msg.segs) ? msg.segs : [];
  for (const seg of segs) {
    if (typeof seg !== 'string' || seg.length > 512) continue;
    if (!peer.segments.has(seg)) {
      peer.segments.add(seg);
      addHolder(swarm, seg, peer.id);
    }
  }
}

function handleWho(peer, msg) {
  const swarm = swarms.get(peer.key);
  if (!swarm) return;
  const seg = String(msg.seg || '');
  const set = swarm.holders.get(seg);
  const peers = [];
  if (set) {
    for (const id of set) {
      if (id !== peer.id) peers.push(id);
      if (peers.length >= MAX_HOLDERS_RETURNED) break;
    }
  }
  send(peer, { t: 'holders', seg, peers });
}

function handleSignal(peer, msg) {
  const swarm = swarms.get(peer.key);
  if (!swarm) return;
  const target = swarm.peers.get(String(msg.to || ''));
  if (!target) return;
  send(target, { t: 'signal', from: peer.id, data: msg.data });
}

function handleStats(peer, msg) {
  const swarm = swarms.get(peer.key);
  if (!swarm) return;
  const p2p = Math.max(0, Number(msg.p2p) || 0);
  const server = Math.max(0, Number(msg.server) || 0);
  peer.p2pBytes += p2p;
  peer.serverBytes += server;
  swarm.p2pBytes += p2p;
  swarm.serverBytes += server;
  swarm.pending.p2p += p2p;
  swarm.pending.server += server;
}

function send(peer, obj) {
  if (peer.ws.readyState === peer.ws.OPEN) {
    try {
      peer.ws.send(JSON.stringify(obj));
    } catch {
      /* ignore */
    }
  }
}

// ── Snapshots for the dashboard history ────────────────────────────────
async function snapshot() {
  for (const swarm of swarms.values()) {
    const { p2p, server } = swarm.pending;
    const peers = swarm.peers.size;
    if (p2p === 0 && server === 0 && peers === 0) continue;
    swarm.pending.p2p = 0;
    swarm.pending.server = 0;
    try {
      await prisma.p2PSnapshot.create({
        data: {
          streamKey: swarm.key,
          peers,
          p2pBytes: p2p,
          serverBytes: server,
        },
      });
    } catch (err) {
      console.error('[p2p] snapshot failed:', err.message);
    }
  }
}

// ── Public stats for the dashboard ─────────────────────────────────────
export function getLiveStats() {
  const list = [];
  let totPeers = 0;
  let totP2P = 0;
  let totServer = 0;

  for (const swarm of swarms.values()) {
    if (swarm.peers.size === 0) continue;
    const total = swarm.p2pBytes + swarm.serverBytes;
    list.push({
      streamKey: swarm.key,
      peers: swarm.peers.size,
      p2pBytes: swarm.p2pBytes,
      serverBytes: swarm.serverBytes,
      ratio: total > 0 ? swarm.p2pBytes / total : 0,
    });
    totPeers += swarm.peers.size;
    totP2P += swarm.p2pBytes;
    totServer += swarm.serverBytes;
  }

  list.sort((a, b) => b.peers - a.peers);
  const grand = totP2P + totServer;
  return {
    enabled: config.p2p.enabled,
    swarms: list,
    totals: {
      peers: totPeers,
      activeSwarms: list.length,
      p2pBytes: totP2P,
      serverBytes: totServer,
      ratio: grand > 0 ? totP2P / grand : 0,
    },
  };
}

// ── Attach to the HTTP server ──────────────────────────────────────────
export function attachP2P(server) {
  if (!config.p2p.enabled) {
    console.log('[p2p] disabled via P2P_ENABLED=false');
    return null;
  }

  const wss = new WebSocketServer({ server, path: '/p2p' });

  wss.on('connection', (ws) => {
    const peer = {
      ws,
      id: null,
      key: null,
      token: null,
      segments: new Set(),
      p2pBytes: 0,
      serverBytes: 0,
      removed: false,
      joined: false,
      alive: true,
    };

    // @ts-ignore attach liveness flag for the heartbeat sweeper
    ws.__ariAlive = true;
    ws.on('pong', () => {
      peer.alive = true;
      // @ts-ignore
      ws.__ariAlive = true;
    });
    ws.on('message', (raw) => handleMessage(peer, raw));
    ws.on('close', () => removePeer(peer));
    ws.on('error', () => removePeer(peer));
  });

  // Heartbeat to reap dead connections.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      // @ts-ignore
      if (ws.__ariAlive === false) {
        ws.terminate();
        continue;
      }
      // @ts-ignore
      ws.__ariAlive = false;
      ws.ping();
    }
  }, 30000);
  heartbeat.unref?.();

  const snap = setInterval(snapshot, config.p2p.snapshotSeconds * 1000);
  snap.unref?.();

  console.log(
    `[p2p] tracker listening on /p2p (maxPeers=${config.p2p.maxPeers}, ` +
      `iceServers=${config.p2p.iceServers.length})`,
  );
  return wss;
}

export default { attachP2P, getLiveStats };
