import express from 'express';
import crypto from 'node:crypto';
import prisma from '../lib/prisma.js';
import { requireAdmin } from '../middleware/auth.js';
import { getSetting, setSetting } from '../lib/settings.js';
import {
  edgeStatus,
  hashSecret,
  newSecret,
  normalizeBaseUrl,
} from '../lib/edges.js';

const router = express.Router();

const REG_TOKEN_KEY = 'edge_registration_token';

function withStatus(edge) {
  return { ...edge, status: edgeStatus(edge), secretHash: undefined };
}

// ── Admin: list edges ──────────────────────────────────────────────────
router.get('/', requireAdmin, async (_req, res) => {
  try {
    const edges = await prisma.edgeServer.findMany({ orderBy: { createdAt: 'desc' } });
    res.json({ edges: edges.map(withStatus) });
  } catch (err) {
    console.error('[edges] list failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ── Admin: manually add an edge ────────────────────────────────────────
router.post('/', requireAdmin, async (req, res) => {
  const baseUrl = normalizeBaseUrl(req.body?.baseUrl);
  if (!baseUrl) return res.status(400).json({ error: 'invalid_base_url' });
  const name = String(req.body?.name || '').trim() || baseUrl;
  const region = req.body?.region ? String(req.body.region).trim() : null;
  const weight = Math.max(1, Math.min(100, parseInt(req.body?.weight || '1', 10) || 1));

  try {
    const edge = await prisma.edgeServer.create({
      data: { name, baseUrl, region, weight },
    });
    res.status(201).json({ edge: withStatus(edge) });
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'edge_exists' });
    console.error('[edges] create failed:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── Admin: update an edge ──────────────────────────────────────────────
router.patch('/:id', requireAdmin, async (req, res) => {
  const data = {};
  if (typeof req.body?.name === 'string' && req.body.name.trim()) data.name = req.body.name.trim();
  if (req.body?.region !== undefined) data.region = String(req.body.region || '').trim() || null;
  if (req.body?.weight !== undefined) {
    data.weight = Math.max(1, Math.min(100, parseInt(req.body.weight, 10) || 1));
  }
  if (typeof req.body?.isActive === 'boolean') data.isActive = req.body.isActive;

  try {
    const edge = await prisma.edgeServer.update({ where: { id: req.params.id }, data });
    res.json({ edge: withStatus(edge) });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'not_found' });
    console.error('[edges] update failed:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── Admin: remove an edge ──────────────────────────────────────────────
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await prisma.edgeServer.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'not_found' });
    console.error('[edges] delete failed:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── Admin: registration token ──────────────────────────────────────────
router.get('/registration-token', requireAdmin, async (_req, res) => {
  const token = await getSetting(REG_TOKEN_KEY, null);
  res.json({ token });
});

router.post('/registration-token', requireAdmin, async (_req, res) => {
  const token = crypto.randomBytes(24).toString('hex');
  await setSetting(REG_TOKEN_KEY, token);
  res.json({ token });
});

// ── Public: edge self-registration ─────────────────────────────────────
// The edge installer calls this with the dashboard-issued registration
// token. On success it receives a per-edge secret for heartbeats.
router.post('/register', async (req, res) => {
  const token = String(req.body?.token || '');
  const expected = await getSetting(REG_TOKEN_KEY, null);
  if (!expected) return res.status(403).json({ error: 'registration_disabled' });
  if (token.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
    return res.status(403).json({ error: 'invalid_token' });
  }

  const baseUrl = normalizeBaseUrl(req.body?.baseUrl);
  if (!baseUrl) return res.status(400).json({ error: 'invalid_base_url' });

  const name = String(req.body?.name || '').trim() || baseUrl;
  const region = req.body?.region ? String(req.body.region).trim() : null;
  const secret = newSecret();
  const secretHash = hashSecret(secret);

  try {
    const edge = await prisma.edgeServer.upsert({
      where: { baseUrl },
      update: { name, region, secretHash, isActive: true, lastSeenAt: new Date() },
      create: { name, baseUrl, region, secretHash, lastSeenAt: new Date() },
    });
    console.log(`[edges] registered ${edge.name} (${baseUrl})`);
    res.json({ edgeId: edge.id, secret, name: edge.name });
  } catch (err) {
    console.error('[edges] register failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ── Public: edge heartbeat ─────────────────────────────────────────────
router.post('/heartbeat', async (req, res) => {
  const edgeId = String(req.body?.edgeId || '');
  const secret = String(req.body?.secret || '');
  if (!edgeId || !secret) return res.status(400).json({ error: 'missing_fields' });

  try {
    const edge = await prisma.edgeServer.findUnique({ where: { id: edgeId } });
    if (!edge || !edge.secretHash) return res.status(404).json({ error: 'unknown_edge' });

    if (hashSecret(secret) !== edge.secretHash) {
      return res.status(403).json({ error: 'invalid_secret' });
    }

    const loadPct = Number.isFinite(Number(req.body?.loadPct))
      ? Math.max(0, Math.min(100, Math.round(Number(req.body.loadPct))))
      : null;
    const version = req.body?.version ? String(req.body.version).slice(0, 64) : undefined;

    await prisma.edgeServer.update({
      where: { id: edgeId },
      data: { lastSeenAt: new Date(), loadPct, ...(version ? { version } : {}) },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[edges] heartbeat failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
