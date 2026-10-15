import express from 'express';
import cookieParser from 'cookie-parser';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import config from './config.js';
import prisma from './lib/prisma.js';
import { redis } from './lib/redis.js';
import { attachP2P } from './p2p/tracker.js';

import setupRoutes from './routes/setup.js';
import authRoutes from './routes/auth.js';
import streamRoutes from './routes/streams.js';
import whitelistRoutes from './routes/whitelist.js';
import viewerRoutes from './routes/viewers.js';
import rtmpRoutes from './routes/rtmp.js';
import playbackRoutes from './routes/playback.js';
import p2pRoutes from './routes/p2p.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

const app = express();

// Behind nginx — trust the local reverse proxy for correct client IPs.
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');

app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(cookieParser());

// ── API ────────────────────────────────────────────────────────────────
app.use('/api/setup', setupRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/streams', streamRoutes);
app.use('/api/whitelist', whitelistRoutes);
app.use('/api/viewers', viewerRoutes);
app.use('/api/rtmp', rtmpRoutes);
app.use('/api/playback', playbackRoutes);
app.use('/api/p2p', p2pRoutes);

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    redis: redis.status,
    env: config.env,
    time: new Date().toISOString(),
  });
});

// ── Static frontend ────────────────────────────────────────────────────
app.use(
  express.static(publicDir, {
    extensions: ['html'],
    setHeaders(res, filePath) {
      // Never cache the player or dashboard shell aggressively.
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }),
);

// Root → index.html (static middleware already handles this, but be explicit).
app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ── Errors ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'not_found' });
  }
  return res.status(404).sendFile(path.join(publicDir, 'index.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[server] unhandled error:', err);
  res.status(500).json({ error: 'internal_error' });
});

// ── Lifecycle ──────────────────────────────────────────────────────────
const server = http.createServer(app);

// Attach the P2P signaling tracker (WebSocket on /p2p) to the same server.
attachP2P(server);

server.listen(config.port, config.host, () => {
  console.log(`[ari-rtmp] API listening on http://${config.host}:${config.port}`);
  console.log(`[ari-rtmp] public base: ${config.publicBaseUrl}`);
  if (config.p2p.enabled) {
    console.log('[ari-rtmp] P2P segment sharing enabled');
  }
});

async function shutdown(signal) {
  console.log(`[ari-rtmp] ${signal} received, shutting down...`);
  server.close(async () => {
    try {
      await prisma.$disconnect();
      redis.disconnect();
    } catch {
      /* ignore */
    }
    process.exit(0);
  });
  // Hard exit if graceful shutdown stalls.
  setTimeout(() => process.exit(1), 8000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
