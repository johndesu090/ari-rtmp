import crypto from 'node:crypto';
import prisma from './prisma.js';

// Characters used for the watermark. Deliberately avoids visually ambiguous
// glyphs (0/O, 1/I/L) so operators can read them off a screen reliably.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DEFAULT_LENGTH = 6;

export function randomWatermark(length = DEFAULT_LENGTH) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

/**
 * Generate a unique watermark that does not already exist in the DB.
 * Retries on the (astronomically unlikely) collision.
 */
export async function uniqueWatermark(length = DEFAULT_LENGTH, attempts = 8) {
  for (let i = 0; i < attempts; i += 1) {
    const candidate = randomWatermark(length);
    const existing = await prisma.viewerSession.findUnique({
      where: { watermark: candidate },
      select: { id: true },
    });
    if (!existing) return candidate;
  }
  // Fall back to a longer value to guarantee uniqueness.
  return randomWatermark(length + 4);
}

export function generateStreamKey() {
  // 32 hex chars, URL/RTMP safe.
  return crypto.randomBytes(16).toString('hex');
}
