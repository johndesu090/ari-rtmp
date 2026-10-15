import express from 'express';
import prisma from '../lib/prisma.js';
import { requireAdmin } from '../middleware/auth.js';

const router = express.Router();
router.use(requireAdmin);

// GET /api/viewers?streamId=&limit=
// The viewer activity log: watermark ↔ IP relationships.
router.get('/', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '200', 10) || 200, 1000);
  const where = {};
  if (req.query.streamId) where.streamId = String(req.query.streamId);

  try {
    const viewers = await prisma.viewerSession.findMany({
      where,
      orderBy: { lastSeen: 'desc' },
      take: limit,
      include: { stream: { select: { id: true, title: true, streamKey: true } } },
    });
    res.json({ viewers });
  } catch (err) {
    console.error('[viewers] list failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
