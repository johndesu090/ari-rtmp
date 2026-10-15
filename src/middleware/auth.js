import { verifyAdminToken, adminCookieName } from '../lib/tokens.js';

/**
 * Require a valid admin session (httpOnly cookie). Attaches req.admin.
 */
export function requireAdmin(req, res, next) {
  const token = req.cookies?.[adminCookieName];
  if (!token) {
    return res.status(401).json({ error: 'authentication_required' });
  }
  try {
    const payload = verifyAdminToken(token);
    req.admin = { id: payload.sub, username: payload.username };
    return next();
  } catch {
    res.clearCookie(adminCookieName, { path: '/' });
    return res.status(401).json({ error: 'session_expired' });
  }
}

/**
 * Guard used by nginx-internal endpoints (on_publish, playback verify).
 * These are only reachable from localhost via the reverse proxy, but we
 * additionally require a shared secret header when configured.
 */
export function requireInternal(req, res, next) {
  const expected = process.env.INTERNAL_API_TOKEN;
  if (!expected) return next(); // not configured → rely on network isolation

  const provided =
    req.headers['x-internal-token'] || req.query.internal_token || '';
  if (provided !== expected) {
    return res.status(403).json({ error: 'forbidden' });
  }
  return next();
}
