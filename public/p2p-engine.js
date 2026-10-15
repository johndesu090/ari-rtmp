/*
 * Ari RTMP — P2P segment-sharing engine (SwarmCloud-style).
 *
 * Viewers of the same stream form a WebRTC swarm and exchange HLS media
 * segments directly, reducing origin-server egress. Playlists (.m3u8) and
 * anything the swarm does not have fall back to the server, so playback is
 * never interrupted.
 *
 * Exposes `window.AriP2P`. No external dependencies.
 */
(function () {
  'use strict';

  const CHUNK_SIZE = 16 * 1024; // 16 KiB data-channel frames
  const CACHE_MAX = 40; // segments kept in memory per peer
  const REQUEST_TIMEOUT_MS = 8000;
  const DC_OPEN_TIMEOUT_MS = 4000;
  const WHO_TIMEOUT_MS = 700;
  const STATS_INTERVAL_MS = 5000;
  const MAX_BUFFERED = 4 * 1024 * 1024;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const randId = () => Math.random().toString(36).slice(2, 12);

  class AriP2P {
    constructor(opts) {
      this.trackerUrl = opts.trackerUrl;
      this.key = opts.key;
      this.token = opts.token;
      this.iceServers = opts.iceServers || [];
      this.maxPeers = opts.maxPeers || 5;

      this.enabled = false;
      this.destroyed = false;
      this.ws = null;
      this.id = null;

      /** @type {Map<string, PeerEntry>} */
      this.peers = new Map();
      /** @type {Map<string, ArrayBuffer>} */
      this.cache = new Map();
      /** @type {Map<string, function>} */
      this.whoWaiters = new Map();

      this.p2pBytes = 0;
      this.serverBytes = 0;
      this._pendP2P = 0;
      this._pendServer = 0;
      this._statsTimer = null;
      this._reconnectDelay = 1000;
    }

    // ── Connection lifecycle ───────────────────────────────────────────
    connect() {
      if (this.destroyed || this.ws) return;
      try {
        this.ws = new WebSocket(this.trackerUrl);
      } catch {
        return;
      }

      this.ws.onopen = () => {
        this._reconnectDelay = 1000;
        this.send({ t: 'join', key: this.key, token: this.token });
      };

      this.ws.onmessage = (ev) => this._onMessage(ev.data);

      this.ws.onclose = () => {
        this.enabled = false;
        this._closeAllPeers();
        this.ws = null;
        if (!this.destroyed) this._scheduleReconnect();
      };

      this.ws.onerror = () => {
        /* onclose will handle reconnect */
      };

      if (!this._statsTimer) {
        this._statsTimer = setInterval(() => this._reportStats(), STATS_INTERVAL_MS);
      }
    }

    _scheduleReconnect() {
      const delay = this._reconnectDelay;
      this._reconnectDelay = Math.min(this._reconnectDelay * 2, 30000);
      setTimeout(() => {
        if (!this.destroyed) this.connect();
      }, delay);
    }

    send(obj) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify(obj));
        } catch {
          /* ignore */
        }
      }
    }

    updateToken(token) {
      this.token = token;
      this.send({ t: 'reauth', token });
    }

    destroy() {
      this.destroyed = true;
      clearInterval(this._statsTimer);
      this._statsTimer = null;
      this._closeAllPeers();
      if (this.ws) {
        try {
          this.ws.close();
        } catch {
          /* ignore */
        }
        this.ws = null;
      }
    }

    // ── Tracker messages ───────────────────────────────────────────────
    _onMessage(raw) {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      switch (msg.t) {
        case 'joined':
          this.id = msg.id;
          this.enabled = true;
          if (Array.isArray(msg.iceServers) && msg.iceServers.length) {
            this.iceServers = msg.iceServers;
          }
          (msg.peers || []).forEach((id) => this._ensureConnection(id, true));
          break;
        case 'peers':
          (msg.ids || []).forEach((id) => this._ensureConnection(id, true));
          break;
        case 'peer-left':
          this._dropPeer(msg.id);
          break;
        case 'holders': {
          const resolve = this.whoWaiters.get(msg.seg);
          if (resolve) {
            this.whoWaiters.delete(msg.seg);
            resolve(msg.peers || []);
          }
          break;
        }
        case 'signal':
          this._onSignal(msg.from, msg.data);
          break;
        default:
          break;
      }
    }

    // ── WebRTC plumbing ────────────────────────────────────────────────
    _ensureConnection(peerId, initiate) {
      if (this.destroyed || !peerId) return null;
      let entry = this.peers.get(peerId);
      if (entry) return entry;

      const pc = new RTCPeerConnection({ iceServers: this.iceServers });
      entry = { pc, dc: null, dcReady: false, serving: false, incoming: null, pending: null };
      this.peers.set(peerId, entry);

      pc.onicecandidate = (e) => {
        if (e.candidate) this.send({ t: 'signal', to: peerId, data: { ice: e.candidate } });
      };
      pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        if (st === 'failed' || st === 'closed' || st === 'disconnected') {
          this._dropPeer(peerId);
        }
      };

      if (initiate) {
        try {
          const dc = pc.createDataChannel('ari', { ordered: true });
          this._setupDC(peerId, entry, dc);
        } catch {
          /* ignore */
        }
        pc.createOffer()
          .then((offer) => pc.setLocalDescription(offer))
          .then(() => this.send({ t: 'signal', to: peerId, data: { sdp: pc.localDescription } }))
          .catch(() => this._dropPeer(peerId));
      } else {
        pc.ondatachannel = (e) => this._setupDC(peerId, entry, e.channel);
      }

      return entry;
    }

    _setupDC(peerId, entry, dc) {
      dc.binaryType = 'arraybuffer';
      entry.dc = dc;
      dc.onopen = () => {
        entry.dcReady = true;
      };
      dc.onclose = () => {
        entry.dcReady = false;
      };
      dc.onmessage = (ev) => this._onDC(peerId, entry, ev.data);
    }

    async _onSignal(from, data) {
      if (!from || !data) return;
      const entry = this._ensureConnection(from, false);
      if (!entry) return;
      const pc = entry.pc;
      try {
        if (data.sdp) {
          await pc.setRemoteDescription(data.sdp);
          if (data.sdp.type === 'offer') {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            this.send({ t: 'signal', to: from, data: { sdp: pc.localDescription } });
          }
        } else if (data.ice) {
          await pc.addIceCandidate(data.ice);
        }
      } catch {
        /* ignore malformed signal */
      }
    }

    _dropPeer(peerId) {
      const entry = this.peers.get(peerId);
      if (!entry) return;
      this.peers.delete(peerId);
      try {
        if (entry.dc) entry.dc.close();
      } catch { /* ignore */ }
      try {
        entry.pc.close();
      } catch { /* ignore */ }
      if (entry.pending) {
        clearTimeout(entry.pending.timer);
        entry.pending.reject(new Error('peer closed'));
        entry.pending = null;
      }
    }

    _closeAllPeers() {
      for (const id of Array.from(this.peers.keys())) this._dropPeer(id);
    }

    // ── Data-channel protocol ──────────────────────────────────────────
    _onDC(peerId, entry, data) {
      if (typeof data === 'string') {
        let msg;
        try {
          msg = JSON.parse(data);
        } catch {
          return;
        }
        switch (msg.t) {
          case 'want':
            this._serve(entry, msg.id, msg.seg);
            break;
          case 'nope':
            if (entry.pending && entry.pending.id === msg.id) {
              clearTimeout(entry.pending.timer);
              entry.pending.reject(new Error('nope'));
              entry.pending = null;
            }
            break;
          case 'head':
            entry.incoming = { id: msg.id, size: msg.size, chunks: [], received: 0 };
            break;
          case 'done': {
            const inc = entry.incoming;
            entry.incoming = null;
            if (!inc) break;
            const buf = concatChunks(inc.chunks, inc.received);
            if (entry.pending && entry.pending.id === inc.id) {
              clearTimeout(entry.pending.timer);
              const resolve = entry.pending.resolve;
              entry.pending = null;
              resolve(buf);
            }
            break;
          }
          default:
            break;
        }
      } else {
        // Binary segment chunk for the current incoming transfer.
        if (entry.incoming) {
          entry.incoming.chunks.push(data);
          entry.incoming.received += data.byteLength;
        }
      }
    }

    async _serve(entry, reqId, seg) {
      const dc = entry.dc;
      if (!dc || dc.readyState !== 'open' || entry.serving) {
        this._dcSend(dc, { t: 'nope', id: reqId });
        return;
      }
      const buf = this.cache.get(seg);
      if (!buf) {
        this._dcSend(dc, { t: 'nope', id: reqId });
        return;
      }

      entry.serving = true;
      try {
        this._dcSend(dc, { t: 'head', id: reqId, size: buf.byteLength });
        const u8 = new Uint8Array(buf);
        for (let off = 0; off < u8.length; off += CHUNK_SIZE) {
          if (dc.readyState !== 'open') return;
          while (dc.bufferedAmount > MAX_BUFFERED) {
            await sleep(20);
            if (dc.readyState !== 'open') return;
          }
          const end = Math.min(off + CHUNK_SIZE, u8.length);
          const chunk = u8.slice(off, end);
          dc.send(chunk.buffer);
        }
        this._dcSend(dc, { t: 'done', id: reqId });
      } catch {
        /* ignore */
      } finally {
        entry.serving = false;
      }
    }

    _dcSend(dc, obj) {
      if (dc && dc.readyState === 'open') {
        try {
          dc.send(JSON.stringify(obj));
        } catch {
          /* ignore */
        }
      }
    }

    _requestFrom(peerId, seg) {
      return new Promise((resolve, reject) => {
        const entry = this.peers.get(peerId);
        if (!entry || !entry.dcReady || !entry.dc) {
          reject(new Error('not connected'));
          return;
        }
        if (entry.pending) {
          reject(new Error('busy'));
          return;
        }
        const id = randId();
        const timer = setTimeout(() => {
          if (entry.pending && entry.pending.id === id) entry.pending = null;
          reject(new Error('timeout'));
        }, REQUEST_TIMEOUT_MS);
        entry.pending = { id, seg, resolve, reject, timer };
        this._dcSend(entry.dc, { t: 'want', id, seg });
      });
    }

    _waitForDC(entry, timeoutMs) {
      if (entry.dcReady) return Promise.resolve(true);
      return new Promise((resolve) => {
        const start = Date.now();
        const iv = setInterval(() => {
          if (entry.dcReady) {
            clearInterval(iv);
            resolve(true);
          } else if (Date.now() - start > timeoutMs) {
            clearInterval(iv);
            resolve(false);
          }
        }, 100);
      });
    }

    // ── Segment acquisition (the core API) ─────────────────────────────
    async fetchSegment(segKey, fallbackUrl) {
      // 1) local cache
      const cached = this.cache.get(segKey);
      if (cached) {
        this._touchCache(segKey, cached);
        return cached;
      }

      // 2) try the swarm
      if (this.enabled) {
        try {
          const buf = await this._fetchFromSwarm(segKey);
          if (buf) {
            this._putCache(segKey, buf);
            this._announceHave(segKey);
            this.p2pBytes += buf.byteLength;
            this._pendP2P += buf.byteLength;
            return buf;
          }
        } catch {
          /* fall through to server */
        }
      }

      // 3) fall back to the origin server
      const res = await fetch(fallbackUrl, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('http ' + res.status);
      const buf = await res.arrayBuffer();
      this._putCache(segKey, buf);
      this._announceHave(segKey);
      this.serverBytes += buf.byteLength;
      this._pendServer += buf.byteLength;
      return buf;
    }

    async _fetchFromSwarm(segKey) {
      const holders = await this._whoHas(segKey);
      for (const holderId of holders) {
        let entry = this.peers.get(holderId);
        if (!entry) entry = this._ensureConnection(holderId, true);
        if (!entry) continue;
        const ready = await this._waitForDC(entry, DC_OPEN_TIMEOUT_MS);
        if (!ready) continue;
        try {
          return await this._requestFrom(holderId, segKey);
        } catch {
          /* try next holder */
        }
      }
      return null;
    }

    _whoHas(segKey) {
      return new Promise((resolve) => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          resolve([]);
          return;
        }
        this.whoWaiters.set(segKey, resolve);
        this.send({ t: 'who', seg: segKey });
        setTimeout(() => {
          if (this.whoWaiters.has(segKey)) {
            this.whoWaiters.delete(segKey);
            resolve([]);
          }
        }, WHO_TIMEOUT_MS);
      });
    }

    _announceHave(segKey) {
      this.send({ t: 'have', segs: [segKey] });
    }

    // ── Cache (LRU-ish) ────────────────────────────────────────────────
    _putCache(segKey, buf) {
      if (this.cache.has(segKey)) this.cache.delete(segKey);
      this.cache.set(segKey, buf);
      while (this.cache.size > CACHE_MAX) {
        const oldest = this.cache.keys().next().value;
        this.cache.delete(oldest);
      }
    }

    _touchCache(segKey, buf) {
      this.cache.delete(segKey);
      this.cache.set(segKey, buf);
    }

    // ── Stats ──────────────────────────────────────────────────────────
    _reportStats() {
      if (this._pendP2P || this._pendServer) {
        this.send({ t: 'stats', p2p: this._pendP2P, server: this._pendServer });
        this._pendP2P = 0;
        this._pendServer = 0;
      }
    }

    getStats() {
      return {
        enabled: this.enabled,
        peers: this.peers.size,
        p2pBytes: this.p2pBytes,
        serverBytes: this.serverBytes,
      };
    }
  }

  function concatChunks(chunks, total) {
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(new Uint8Array(c), off);
      off += c.byteLength;
    }
    return out.buffer;
  }

  window.AriP2P = AriP2P;
})();
