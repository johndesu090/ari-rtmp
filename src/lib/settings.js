import prisma from './prisma.js';

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
