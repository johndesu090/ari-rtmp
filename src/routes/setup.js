import express from 'express';
import bcrypt from 'bcryptjs';
import prisma from '../lib/prisma.js';

const router = express.Router();

// GET /api/setup/status → { configured: boolean }
router.get('/status', async (_req, res) => {
  try {
    const count = await prisma.admin.count();
    res.json({ configured: count > 0 });
  } catch (err) {
    console.error('[setup] status failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/setup  { username, password }
// Only permitted while no admin exists (first-run).
router.post('/', async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'username_and_password_required' });
  }
  if (String(username).length < 3) {
    return res.status(400).json({ error: 'username_too_short' });
  }
  if (String(password).length < 10) {
    return res.status(400).json({ error: 'password_too_short' });
  }

  try {
    const existing = await prisma.admin.count();
    if (existing > 0) {
      return res.status(409).json({ error: 'already_configured' });
    }

    const passwordHash = await bcrypt.hash(String(password), 12);
    const admin = await prisma.admin.create({
      data: { username: String(username).trim(), passwordHash },
      select: { id: true, username: true, createdAt: true },
    });

    return res.status(201).json({ admin });
  } catch (err) {
    console.error('[setup] create failed:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
