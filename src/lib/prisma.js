import { PrismaClient } from '@prisma/client';

// Reuse a single PrismaClient across hot reloads / modules.
const globalForPrisma = globalThis;

export const prisma =
  globalForPrisma.__ariPrisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === 'production' ? ['warn', 'error'] : ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__ariPrisma = prisma;
}

export default prisma;
