import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth';
import prisma from '@/lib/db/prisma';

// GET /api/portfolios — List user's portfolios with position counts
export async function GET() {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const portfolios = await prisma.portfolio.findMany({
      where: { userId: user.userId },
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

// POST /api/portfolios — Create a new portfolio for current user
export async function POST(request: NextRequest) {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { name, sizingMode, portfolioSize, fixedAmount, kellyMaxPct, kellyWinRate } = await request.json();

    if (!name || !name.trim()) {
      return NextResponse.json({ success: false, error: 'Portfolio name is required' }, { status: 400 });
    }

    const portfolio = await prisma.portfolio.create({
      data: {
        userId: user.userId,
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

// DELETE /api/portfolios — Delete a portfolio (must belong to current user)
export async function DELETE(request: NextRequest) {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { portfolioId, closePositions, deletePortfolio = true } = await request.json();

    if (!portfolioId) {
      return NextResponse.json({ success: false, error: 'portfolioId required' }, { status: 400 });
    }

    // Verify ownership
    const portfolio = await prisma.portfolio.findUnique({
      where: { id: portfolioId },
      include: {
        entries: { where: { status: 'active' }, select: { id: true } },
      },
    });

    if (!portfolio || portfolio.userId !== user.userId) {
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

    if (!deletePortfolio) {
      return NextResponse.json({ success: true, closedPositions: activeCount });
    }

    await prisma.portfolioEntry.deleteMany({ where: { portfolioId } });
    await prisma.portfolio.delete({ where: { id: portfolioId } });

    return NextResponse.json({ success: true, closedPositions: activeCount });
  } catch (error) {
    console.error('Portfolio delete error:', error);
    return NextResponse.json({ success: false, error: 'Failed to delete portfolio' }, { status: 500 });
  }
}
