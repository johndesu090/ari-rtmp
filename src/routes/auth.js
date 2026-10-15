import express from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import prisma from '../lib/prisma.js';
import {
  issueAdminToken,
  adminCookieName,
  adminCookieOptions,
} from '../lib/tokens.js';
import { requireAdmin } from '../middleware/auth.js';

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_attempts' },
});

// POST /api/auth/login  { username, password }
router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'credentials_required' });
  }

  try {
    const admin = await prisma.admin.findUnique({
      where: { username: String(username).trim() },
    });

    // Always run a comparison to reduce user-enumeration timing signal.
    const hash = admin?.passwordHash || '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';
    const ok = await bcrypt.compare(String(password), hash);

    if (!admin || !ok) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    await prisma.admin.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
    });

    const token = issueAdminToken({ adminId: admin.id, username: admin.username });
    res.cookie(adminCookieName, token, adminCookieOptions());
    return res.json({ admin: { id: admin.id, username: admin.username } });
  } catch (err) {
    console.error('[auth] login failed:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.clearCookie(adminCookieName, { path: '/' });
  res.json({ ok: true });
});

// GET /api/auth/me
router.get('/me', requireAdmin, (req, res) => {
  res.json({ admin: req.admin });
});

export default router;
