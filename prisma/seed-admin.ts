/**
 * One-time seed script: Creates the admin user and assigns existing portfolios.
 *
 * Usage:
 *   ADMIN_PASSWORD=yourpassword npx tsx prisma/seed-admin.ts
 *
 * This script is idempotent — safe to run multiple times.
 */

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const ADMIN_EMAIL = 'steve@boomerang.energy';

async function main() {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    console.error('ERROR: Set ADMIN_PASSWORD environment variable');
    console.error('  ADMIN_PASSWORD=yourpassword npx tsx prisma/seed-admin.ts');
    process.exit(1);
  }

  // Check if admin already exists
  const existing = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
  if (existing) {
    console.log(`Admin user ${ADMIN_EMAIL} already exists (id: ${existing.id})`);

    // Still assign orphaned portfolios
    const orphaned = await prisma.portfolio.updateMany({
      where: { userId: null },
      data: { userId: existing.id },
    });
    if (orphaned.count > 0) {
      console.log(`Assigned ${orphaned.count} orphaned portfolio(s) to admin`);
    }
    return;
  }

  // Create admin user
  const passwordHash = await bcrypt.hash(password, 12);
  const admin = await prisma.user.create({
    data: {
      email: ADMIN_EMAIL,
      passwordHash,
      role: 'admin',
    },
  });
  console.log(`Created admin user: ${admin.email} (id: ${admin.id})`);

  // Assign all existing portfolios to admin
  const updated = await prisma.portfolio.updateMany({
    where: { userId: null },
    data: { userId: admin.id },
  });
  console.log(`Assigned ${updated.count} existing portfolio(s) to admin`);
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
