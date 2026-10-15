import path from 'node:path';
import fs from 'node:fs';
import prisma from './prisma.js';
import config from '../config.js';

// Tiny key/value settings store backed by the Setting table.

export async function getSetting(key, fallback = null) {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row ? row.value : fallback;
}

export async function setSetting(key, value) {
  return prisma.setting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
}

export async function deleteSetting(key) {
  await prisma.setting.deleteMany({ where: { key } });
}

// ── HLS transcode settings ─────────────────────────────────────────────
// Segment duration and playlist window for the ABR ladder. The API writes
// them to ${HLS_ROOT}/.hls-settings, which bin/hls-transcode.sh reads when a
// stream starts, so a change takes effect from the next (re)start.
export const HLS_TIME_KEY = 'hls_time';
export const HLS_LIST_SIZE_KEY = 'hls_list_size';
export const HLS_DEFAULTS = { hlsTime: 1, hlsListSize: 4 };
export const HLS_LIMITS = {
  hlsTime: { min: 1, max: 10 },
  hlsListSize: { min: 2, max: 30 },
};

function clampInt(value, { min, max }, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

export async function getHlsSettings() {
  const [time, list] = await Promise.all([
    getSetting(HLS_TIME_KEY, null),
    getSetting(HLS_LIST_SIZE_KEY, null),
  ]);
  return {
    hlsTime: clampInt(time, HLS_LIMITS.hlsTime, HLS_DEFAULTS.hlsTime),
    hlsListSize: clampInt(list, HLS_LIMITS.hlsListSize, HLS_DEFAULTS.hlsListSize),
  };
}

export function hlsSettingsFile() {
  return path.join(config.hlsRoot, '.hls-settings');
}

export async function writeHlsSettingsFile(settings) {
  const file = hlsSettingsFile();
  await fs.promises.mkdir(config.hlsRoot, { recursive: true });
  await fs.promises.writeFile(
    file,
    `HLS_TIME=${settings.hlsTime}\nHLS_LIST_SIZE=${settings.hlsListSize}\n`,
    'utf8',
  );
  return file;
}

export async function setHlsSettings({ hlsTime, hlsListSize }) {
  const next = {
    hlsTime: clampInt(hlsTime, HLS_LIMITS.hlsTime, HLS_DEFAULTS.hlsTime),
    hlsListSize: clampInt(hlsListSize, HLS_LIMITS.hlsListSize, HLS_DEFAULTS.hlsListSize),
  };
  await Promise.all([
    setSetting(HLS_TIME_KEY, String(next.hlsTime)),
    setSetting(HLS_LIST_SIZE_KEY, String(next.hlsListSize)),
  ]);
  await writeHlsSettingsFile(next);
  return next;
}
