import { NextRequest, NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import prisma from '@/lib/db/prisma';

// PUT /api/portfolios/[id] — Update portfolio name or settings
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { id } = await params;
    const body = await request.json();
    const { name, sizingMode, portfolioSize, fixedAmount, kellyMaxPct, kellyWinRate } = body;

    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = name.trim();
    if (sizingMode !== undefined) data.sizingMode = sizingMode;
    if (portfolioSize !== undefined) data.portfolioSize = portfolioSize;
    if (fixedAmount !== undefined) data.fixedAmount = fixedAmount;
    if (kellyMaxPct !== undefined) data.kellyMaxPct = kellyMaxPct;
    if (kellyWinRate !== undefined) data.kellyWinRate = kellyWinRate;

    const portfolio = await prisma.portfolio.update({
      where: { id },
      data,
    });

    return NextResponse.json({ success: true, data: portfolio });
  } catch (error) {
    console.error('Portfolio update error:', error);
    return NextResponse.json({ success: false, error: 'Failed to update portfolio' }, { status: 500 });
  }
}
