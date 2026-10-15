import crypto from 'node:crypto';

// Small shared helpers.

/**
 * Resolve the client IP.
 *
 * Behind Cloudflare the origin only sees Cloudflare's edge IP in
 * `$remote_addr` / `X-Real-IP`; the real client is in `CF-Connecting-IP`
 * (and `True-Client-IP` on Enterprise). We prefer those, then fall back to
 * the proxy headers nginx sets for direct/other-proxy deployments.
 *
 * NOTE: these headers are trusted. Keep the origin reachable only through
 * the proxy (Cloudflare) so they cannot be spoofed.
 */
export function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'] || req.headers['true-client-ip'];
  if (cf) return String(cf).trim();

  const real = req.headers['x-real-ip'];
  if (real) return String(real).trim();

  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();

  return req.socket?.remoteAddress || req.ip || '0.0.0.0';
}

/**
 * Normalise a hostname: lowercase, strip scheme, path, port and leading
 * "www." is intentionally preserved (operators may whitelist either).
 */
export function normalizeHost(input) {
  if (!input) return '';
  let host = String(input).trim().toLowerCase();
  try {
    if (host.includes('://')) {
      host = new URL(host).hostname;
    }
  } catch {
    /* fall through */
  }
  // strip port
  host = host.replace(/:\d+$/, '');
  // strip any path
  host = host.split('/')[0];
  return host;
}

/**
 * Return true if `host` matches an approved domain entry. An entry matches
 * the exact host or any subdomain of it (e.g. `example.com` allows
 * `player.example.com`).
 */
export function hostMatchesWhitelist(host, approvedDomains) {
  const h = normalizeHost(host);
  if (!h) return false;
  for (const entry of approvedDomains) {
    const d = normalizeHost(entry);
    if (!d) continue;
    if (h === d || h.endsWith(`.${d}`)) return true;
  }
  return false;
}

export function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
