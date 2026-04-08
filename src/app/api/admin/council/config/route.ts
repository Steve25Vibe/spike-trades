import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import prisma from '@/lib/db/prisma';

const SINGLETON_ID = 'singleton';
const MIN_ADV = 500_000;
const MAX_ADV = 8_000_000;
const STEP = 500_000;
const DEFAULT_ADV = 5_000_000;

// GET /api/admin/council/config — return current ADV threshold + audit fields
export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    // Upsert ensures the singleton row exists with the default
    const config = await prisma.councilConfig.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, minAdvDollars: DEFAULT_ADV },
      update: {},
    });

    return NextResponse.json({
      success: true,
      data: {
        minAdvDollars: config.minAdvDollars,
        updatedAt: config.updatedAt.toISOString(),
        updatedByEmail: config.updatedByEmail,
      },
    });
  } catch (error) {
    console.error('[council/config] GET failed:', error);
    return NextResponse.json({ error: 'Failed to fetch council config' }, { status: 500 });
  }
}

// POST /api/admin/council/config — update ADV threshold (admin only, with validation)
export async function POST(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const minAdvDollars = (body as { minAdvDollars?: unknown } | null)?.minAdvDollars;

  if (typeof minAdvDollars !== 'number' || !Number.isInteger(minAdvDollars)) {
    return NextResponse.json({ error: 'minAdvDollars must be an integer' }, { status: 400 });
  }

  if (
    minAdvDollars < MIN_ADV ||
    minAdvDollars > MAX_ADV ||
    minAdvDollars % STEP !== 0
  ) {
    return NextResponse.json(
      {
        error: `minAdvDollars must be between ${MIN_ADV} and ${MAX_ADV}, in ${STEP} increments`,
      },
      { status: 400 }
    );
  }

  try {
    const config = await prisma.councilConfig.upsert({
      where: { id: SINGLETON_ID },
      create: {
        id: SINGLETON_ID,
        minAdvDollars,
        updatedByUserId: admin.userId,
        updatedByEmail: admin.email,
      },
      update: {
        minAdvDollars,
        updatedByUserId: admin.userId,
        updatedByEmail: admin.email,
      },
    });

    return NextResponse.json({
      success: true,
      data: {
        minAdvDollars: config.minAdvDollars,
        updatedAt: config.updatedAt.toISOString(),
        updatedByEmail: config.updatedByEmail,
      },
    });
  } catch (error) {
    console.error('[council/config] POST failed:', error);
    return NextResponse.json({ error: 'Failed to update council config' }, { status: 500 });
  }
}
