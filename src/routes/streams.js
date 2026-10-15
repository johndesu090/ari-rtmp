import express from 'express';
import prisma from '../lib/prisma.js';
import { requireAdmin } from '../middleware/auth.js';
import { generateStreamKey } from '../lib/watermark.js';
import { isLive } from '../lib/redis.js';
import config from '../config.js';

const router = express.Router();
router.use(requireAdmin);

function rtmpServerUrl() {
  const base = config.publicBaseUrl;
  if (base.startsWith('https')) {
    // RTMPS is exposed on 1936 when SSL is configured (see nginx templates).
    return `rtmps://${new URL(base).hostname}:1936/live`;
  }
  const host = base.startsWith('http')
    ? new URL(base).hostname
    : base.replace(/^\/+/, '');
  return `rtmp://${host}:1935/live`;
}

// GET /api/streams
router.get('/', async (_req, res) => {
  try {
    const streams = await prisma.stream.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { viewers: true } } },
    });

    const withState = await Promise.all(
      streams.map(async (s) => ({
        ...s,
        live: await isLive(s.streamKey),
        rtmpUrl: rtmpServerUrl(),
        hlsUrl: `${config.publicBaseUrl}/hls/${s.streamKey}/index.m3u8`,
        embedUrl: `${config.publicBaseUrl}/player.html?key=${s.streamKey}`,
      })),
    );

    res.json({ streams: withState });
  } catch (err) {
    console.error('[streams] list failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/streams  { title }
router.post('/', async (req, res) => {
  const title = String(req.body?.title || '').trim() || 'Untitled stream';
  try {
    const stream = await prisma.stream.create({
      data: { title, streamKey: generateStreamKey() },
    });
    res.status(201).json({
      stream: {
        ...stream,
        rtmpUrl: rtmpServerUrl(),
        hlsUrl: `${config.publicBaseUrl}/hls/${stream.streamKey}/index.m3u8`,
        embedUrl: `${config.publicBaseUrl}/player.html?key=${stream.streamKey}`,
      },
    });
  } catch (err) {
    console.error('[streams] create failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// PATCH /api/streams/:id  { title?, isActive?, rotateKey? }
router.patch('/:id', async (req, res) => {
  const { title, isActive, rotateKey } = req.body || {};
  try {
    const data = {};
    if (typeof title === 'string' && title.trim()) data.title = title.trim();
    if (typeof isActive === 'boolean') data.isActive = isActive;
    if (rotateKey === true) data.streamKey = generateStreamKey();

    const stream = await prisma.stream.update({
      where: { id: req.params.id },
      data,
    });
    res.json({ stream });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'not_found' });
    console.error('[streams] update failed:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// DELETE /api/streams/:id
router.delete('/:id', async (req, res) => {
  try {
    await prisma.stream.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'not_found' });
    console.error('[streams] delete failed:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
