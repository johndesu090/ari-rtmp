import express from 'express';
import prisma from '../lib/prisma.js';
import { requireAdmin } from '../middleware/auth.js';
import { normalizeHost } from '../lib/util.js';

const router = express.Router();
router.use(requireAdmin);

// GET /api/whitelist
router.get('/', async (_req, res) => {
  try {
    const domains = await prisma.whitelistedDomain.findMany({
      orderBy: { createdAt: 'desc' },
    });
    res.json({ domains });
  } catch (err) {
    console.error('[whitelist] list failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/whitelist  { domain }
router.post('/', async (req, res) => {
  const domain = normalizeHost(req.body?.domain);
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    return res.status(400).json({ error: 'invalid_domain' });
  }
  try {
    const entry = await prisma.whitelistedDomain.create({ data: { domain } });
    res.status(201).json({ domain: entry });
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'already_whitelisted' });
    }
    console.error('[whitelist] create failed:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// DELETE /api/whitelist/:id
router.delete('/:id', async (req, res) => {
  try {
    await prisma.whitelistedDomain.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'not_found' });
    console.error('[whitelist] delete failed:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
