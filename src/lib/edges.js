import crypto from 'node:crypto';
import prisma from './prisma.js';

// Edges are considered healthy only if they have sent a heartbeat recently.
export const EDGE_STALE_MS = 90_000;

export function edgeStatus(edge) {
  if (!edge.isActive) return 'disabled';
  if (!edge.lastSeenAt) return 'unreachable';
  return Date.now() - new Date(edge.lastSeenAt).getTime() < EDGE_STALE_MS
    ? 'healthy'
    : 'unreachable';
}

export function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex');
}

export function newSecret() {
  return crypto.randomBytes(24).toString('hex');
}

/**
 * Returns the pool of healthy, active edges the player may load-balance
 * across. The origin itself is added by the caller.
 */
export async function getEdgePool() {
  const edges = await prisma.edgeServer.findMany({ where: { isActive: true } });
  const now = Date.now();
  return edges
    .filter((e) => e.lastSeenAt && now - new Date(e.lastSeenAt).getTime() < EDGE_STALE_MS)
    .map((e) => ({ url: e.baseUrl, weight: Math.max(1, e.weight || 1), region: e.region || null }));
}

export function normalizeBaseUrl(input) {
  let url = String(input || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}
