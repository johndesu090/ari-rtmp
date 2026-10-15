import express from 'express';
import prisma from '../lib/prisma.js';
import config from '../config.js';
import { requireAdmin } from '../middleware/auth.js';
import { getLiveStats } from '../p2p/tracker.js';

const router = express.Router();

// GET /api/p2p/config  (public)
// The player uses this to decide whether to start the P2P engine and with
// which ICE servers.
router.get('/config', (_req, res) => {
  res.json({
    enabled: config.p2p.enabled,
    trackerPath: '/p2p',
    maxPeers: config.p2p.maxPeers,
    iceServers: config.p2p.iceServers,
  });
});

// GET /api/p2p/stats  (admin) — live swarm telemetry for the dashboard.
router.get('/stats', requireAdmin, (_req, res) => {
  res.json(getLiveStats());
});

// GET /api/p2p/history?limit=100  (admin) — recent snapshot windows.
router.get('/history', requireAdmin, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100', 10) || 100, 500);
  try {
    const snapshots = await prisma.p2PSnapshot.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    res.json({ snapshots });
  } catch (err) {
    console.error('[p2p] history failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/p2p/summary  (admin) — all-time totals from snapshots.
router.get('/summary', requireAdmin, async (_req, res) => {
  try {
    const agg = await prisma.p2PSnapshot.aggregate({
      _sum: { p2pBytes: true, serverBytes: true },
      _max: { peers: true },
      _count: { _all: true },
    });
    const p2p = agg._sum.p2pBytes || 0;
    const server = agg._sum.serverBytes || 0;
    const total = p2p + server;
    res.json({
      p2pBytes: p2p,
      serverBytes: server,
      ratio: total > 0 ? p2p / total : 0,
      peakPeers: agg._max.peers || 0,
      snapshots: agg._count._all,
    });
  } catch (err) {
    console.error('[p2p] summary failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
