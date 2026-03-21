import { NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import prisma from '@/lib/db/prisma';

// POST /api/portfolios/migrate — One-time migration: create "My Portfolio" and assign orphaned entries
export async function POST() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Check if any portfolios exist
    const count = await prisma.portfolio.count();
    if (count > 0) {
      return NextResponse.json({ success: true, message: 'Migration already done', migrated: 0 });
    }

    // Create default portfolio
    const portfolio = await prisma.portfolio.create({
      data: {
        name: 'My Portfolio',
        sizingMode: 'manual',
        portfolioSize: 100000,
        fixedAmount: 2500,
        kellyMaxPct: 2,
        kellyWinRate: 0.6,
      },
    });

    // Assign all orphaned entries
    const result = await prisma.portfolioEntry.updateMany({
      where: { portfolioId: null },
      data: { portfolioId: portfolio.id },
    });

    return NextResponse.json({
      success: true,
      message: `Created "My Portfolio" and assigned ${result.count} existing positions`,
      portfolioId: portfolio.id,
      migrated: result.count,
    });
  } catch (error) {
    console.error('Portfolio migration error:', error);
    return NextResponse.json({ success: false, error: 'Migration failed' }, { status: 500 });
  }
}
