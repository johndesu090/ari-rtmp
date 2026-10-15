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

// ── Playback binding helpers ───────────────────────────────────────────
// Short, stable fingerprint of a User-Agent. Tokens are bound to this so a
// token scraped from a browser cannot be replayed by a different client.
export function userAgentHash(ua) {
  return crypto.createHash('sha256').update(String(ua || '')).digest('hex').slice(0, 16);
}

// Best-effort blocklist of non-browser clients used to rip HLS. Spoofable, so
// it complements (never replaces) the IP/UA binding.
const SCRAPER_UA_RE =
  /(ffmpeg|ffprobe|libavformat|\blavf\b|yt-dlp|youtube-dl|streamlink|wget|curl|python-requests|python-urllib|go-http-client|aria2|httrack|libmpv|\bmpv\b)/i;
export function isScraperUserAgent(ua) {
  return SCRAPER_UA_RE.test(String(ua || ''));
}

// Browsers we refuse to serve. Firefox is blocked because its
// picture-in-picture cannot be disabled reliably. This UA test is spoofable,
// so it is only the server-side half of the block; the player also refuses to
// boot on a real Gecko engine, which a spoofed user-agent cannot hide.
const BLOCKED_BROWSER_UA_RE = /(firefox|fxios)/i;
export function isBlockedBrowser(ua) {
  return BLOCKED_BROWSER_UA_RE.test(String(ua || ''));
}

// ── Network identity ───────────────────────────────────────────────────
// IPv6 hosts use SLAAC privacy addresses: every device has a random interface
// identifier that also rotates over time, so the full address is unstable.
// The network (the /64 prefix) is stable, so we group IPv6 viewers by /64 and
// leave IPv4 addresses as-is. This keeps a watermark stable per network.
function ipv6ToBytes(input) {
  let ip = String(input).trim();
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);
  if (ip.includes('.')) {
    const lastColon = ip.lastIndexOf(':');
    if (lastColon === -1) return null;
    const v4 = ip.slice(lastColon + 1).split('.');
    if (v4.length !== 4) return null;
    const b = v4.map((p) => Number(p));
    if (b.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    ip = `${ip.slice(0, lastColon + 1)}${(((b[0] << 8) | b[1]).toString(16))}:${(((b[2] << 8) | b[3]).toString(16))}`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const hextets = [...head, ...Array(missing).fill('0'), ...tail];
  if (hextets.length !== 8) return null;
  const bytes = [];
  for (const h of hextets) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(h)) return null;
    const v = parseInt(h, 16);
    bytes.push((v >> 8) & 0xff, v & 0xff);
  }
  return bytes;
}

export function clientNetwork(ip) {
  const s = String(ip || '').trim();
  if (!s) return '';
  if (!s.includes(':')) return s; // IPv4: use the full address
  const bytes = ipv6ToBytes(s);
  if (!bytes) return s; // unparseable: fall back to the raw value
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) → treat as the plain IPv4 address.
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
  }
  const hextets = [];
  for (let i = 0; i < 8; i += 2) {
    hextets.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  }
  return `${hextets.join(':')}::/64`;
}
