import { NextRequest, NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import prisma from '@/lib/db/prisma';

// GET /api/portfolios — List all portfolios with position counts
export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const portfolios = await prisma.portfolio.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { entries: { where: { status: 'active' } } } },
        entries: {
          where: { status: 'active' },
          select: { positionSize: true },
        },
      },
    });

    const data = portfolios.map((p) => ({
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      sizingMode: p.sizingMode,
      portfolioSize: p.portfolioSize,
      fixedAmount: p.fixedAmount,
      kellyMaxPct: p.kellyMaxPct,
      kellyWinRate: p.kellyWinRate,
      totalPositions: p._count.entries,
      activePositions: p.entries.length,
      totalInvested: p.entries.reduce((sum, e) => sum + e.positionSize, 0),
    }));

    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error('Portfolios list error:', error);
    return NextResponse.json({ success: false, error: 'Failed to fetch portfolios' }, { status: 500 });
  }
}

// POST /api/portfolios — Create a new portfolio
export async function POST(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { name, sizingMode, portfolioSize, fixedAmount, kellyMaxPct, kellyWinRate } = await request.json();

    if (!name || !name.trim()) {
      return NextResponse.json({ success: false, error: 'Portfolio name is required' }, { status: 400 });
    }

    const portfolio = await prisma.portfolio.create({
      data: {
        name: name.trim(),
        sizingMode: sizingMode || 'manual',
        portfolioSize: portfolioSize ?? 100000,
        fixedAmount: fixedAmount ?? 2500,
        kellyMaxPct: kellyMaxPct ?? 2,
        kellyWinRate: kellyWinRate ?? 0.6,
      },
    });

    return NextResponse.json({ success: true, data: portfolio });
  } catch (error) {
    console.error('Portfolio create error:', error);
    return NextResponse.json({ success: false, error: 'Failed to create portfolio' }, { status: 500 });
  }
}

// DELETE /api/portfolios — Delete a portfolio and all its entries
// If closePositions is true, auto-closes active positions first.
export async function DELETE(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { portfolioId, closePositions } = await request.json();

    if (!portfolioId) {
      return NextResponse.json({ success: false, error: 'portfolioId required' }, { status: 400 });
    }

    const portfolio = await prisma.portfolio.findUnique({
      where: { id: portfolioId },
      include: {
        entries: { where: { status: 'active' }, select: { id: true } },
      },
    });

    if (!portfolio) {
      return NextResponse.json({ success: false, error: 'Portfolio not found' }, { status: 404 });
    }

    const activeCount = portfolio.entries.length;

    if (activeCount > 0 && !closePositions) {
      return NextResponse.json({
        success: false,
        error: `Portfolio has ${activeCount} active position(s).`,
        activeCount,
        requiresClose: true,
      }, { status: 400 });
    }

    // Close active positions if requested
    if (activeCount > 0 && closePositions) {
      await prisma.portfolioEntry.updateMany({
        where: { portfolioId, status: 'active' },
        data: {
          status: 'closed',
          exitDate: new Date(),
          exitReason: 'portfolio_deleted',
        },
      });
    }

    // Delete all entries
    await prisma.portfolioEntry.deleteMany({
      where: { portfolioId },
    });

    // Delete the portfolio
    await prisma.portfolio.delete({ where: { id: portfolioId } });

    return NextResponse.json({ success: true, closedPositions: activeCount });
  } catch (error) {
    console.error('Portfolio delete error:', error);
    return NextResponse.json({ success: false, error: 'Failed to delete portfolio' }, { status: 500 });
  }
}
