import { NextRequest, NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import prisma from '@/lib/db/prisma';
import { calculateKellyFraction, countTradingDays } from '@/lib/utils';
import { getBatchQuotes } from '@/lib/api/fmp';

// GET /api/portfolio — Get all portfolio positions with LIVE P&L
export async function GET(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const status = request.nextUrl.searchParams.get('status') || 'active';
  const portfolioId = request.nextUrl.searchParams.get('portfolioId');

  try {
    const where: Record<string, unknown> = {};
    if (status !== 'all') where.status = status;
    if (portfolioId) where.portfolioId = portfolioId;

    const positions = await prisma.portfolioEntry.findMany({
      where,
      orderBy: { entryDate: 'desc' },
      include: { spike: true },
    });

    // For active positions, fetch LIVE quotes to calculate unrealized P&L
    const activePositions = positions.filter((p) => p.status === 'active');
    const activeTickers = Array.from(new Set(activePositions.map((p) => p.ticker)));

    let liveQuotes = new Map<string, number>();
    if (activeTickers.length > 0) {
      try {
        const quotes = await getBatchQuotes(activeTickers);
        for (const q of quotes) {
          liveQuotes.set(q.ticker, q.price);
        }
      } catch {
        // If live quotes fail, we'll show entry prices only
        console.warn('[Portfolio] Could not fetch live quotes');
      }
    }

    // Calculate per-position live P&L
    const enrichedPositions = positions.map((p) => {
      const currentPrice = liveQuotes.get(p.ticker) || p.entryPrice;
      const unrealizedPnl = (currentPrice - p.entryPrice) * p.shares;
      const unrealizedPnlPct = ((currentPrice - p.entryPrice) / p.entryPrice) * 100;
      const currentValue = currentPrice * p.shares;
      const daysHeld = countTradingDays(new Date(p.entryDate), new Date());

      // Progress toward targets
      const priceChange = currentPrice - p.entryPrice;
      const target3Change = (p.target3Day || p.entryPrice) - p.entryPrice;
      const progressTo3Day = target3Change !== 0 ? (priceChange / target3Change) * 100 : 0;

      // Risk status
      let riskStatus: 'on_track' | 'caution' | 'danger' | 'target_hit' = 'on_track';
      if (p.stopLoss && currentPrice <= p.stopLoss) riskStatus = 'danger';
      else if (unrealizedPnlPct <= -5) riskStatus = 'danger';
      else if (unrealizedPnlPct <= -2) riskStatus = 'caution';
      else if (p.target3Day && currentPrice >= p.target3Day) riskStatus = 'target_hit';

      return {
        id: p.id,
        spikeId: p.spikeId,
        ticker: p.ticker,
        name: p.name,
        entryPrice: p.entryPrice,
        currentPrice,
        shares: p.shares,
        positionSize: p.positionSize,
        currentValue,
        positionPct: p.positionPct,
        target3Day: p.target3Day,
        target5Day: p.target5Day,
        target8Day: p.target8Day,
        stopLoss: p.stopLoss,
        entryDate: p.entryDate,
        daysHeld,
        exitPrice: p.exitPrice,
        exitDate: p.exitDate,
        exitReason: p.exitReason,
        realizedPnl: p.realizedPnl,
        realizedPnlPct: p.realizedPnlPct,
        unrealizedPnl,
        unrealizedPnlPct,
        progressTo3Day: Math.min(Math.max(progressTo3Day, -100), 200),
        riskStatus,
        status: p.status,
        alerts: {
          sent3Day: p.alertSent3Day,
          sent5Day: p.alertSent5Day,
          sent8Day: p.alertSent8Day,
          deviationAlert: p.deviationAlert,
        },
        // Original spike data for reference
        spikeScore: p.spike?.spikeScore,
        originalConfidence: p.spike?.confidence,
        spikeNarrative: p.spike?.narrative,
      };
    });

    // Portfolio-level summary with live data
    const active = enrichedPositions.filter((p) => p.status === 'active');
    const closed = enrichedPositions.filter((p) => p.status === 'closed' || p.status === 'stopped');
    const wins = closed.filter((p) => (p.realizedPnlPct || 0) > 0);

    const totalInvested = active.reduce((sum, p) => sum + p.positionSize, 0);
    const totalCurrentValue = active.reduce((sum, p) => sum + p.currentValue, 0);
    const totalUnrealizedPnl = active.reduce((sum, p) => sum + p.unrealizedPnl, 0);
    const totalUnrealizedPnlPct = totalInvested > 0 ? (totalUnrealizedPnl / totalInvested) * 100 : 0;
    const totalRealizedPnl = closed.reduce((sum, p) => sum + (p.realizedPnl || 0), 0);
    const avgReturn = closed.length > 0
      ? closed.reduce((sum, p) => sum + (p.realizedPnlPct || 0), 0) / closed.length
      : 0;

    // Per-position weight in portfolio
    const positionsWithWeight = active.map((p) => ({
      ...p,
      portfolioWeight: totalCurrentValue > 0 ? (p.currentValue / totalCurrentValue) * 100 : 0,
      pnlContribution: totalUnrealizedPnl !== 0 ? (p.unrealizedPnl / Math.abs(totalUnrealizedPnl)) * 100 : 0,
    }));

    return NextResponse.json({
      success: true,
      data: {
        positions: [...positionsWithWeight, ...closed.map((p) => ({ ...p, portfolioWeight: 0, pnlContribution: 0 }))],
        summary: {
          activePositions: active.length,
          totalInvested,
          totalCurrentValue,
          totalUnrealizedPnl,
          totalUnrealizedPnlPct,
          totalRealizedPnl,
          totalCombinedPnl: totalUnrealizedPnl + totalRealizedPnl,
          winRate: closed.length > 0 ? (wins.length / closed.length) * 100 : 0,
          avgReturn,
          totalTrades: closed.length,
          bestPosition: active.length > 0
            ? active.reduce((best, p) => p.unrealizedPnlPct > best.unrealizedPnlPct ? p : best)
            : null,
          worstPosition: active.length > 0
            ? active.reduce((worst, p) => p.unrealizedPnlPct < worst.unrealizedPnlPct ? p : worst)
            : null,
        },
      },
    });
  } catch (error) {
    console.error('Portfolio fetch error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch portfolio' },
      { status: 500 }
    );
  }
}

// POST /api/portfolio — Lock in spike(s)
export async function POST(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { spikeId, spikeIds, portfolioId, portfolioSize, mode, shares: manualShares, positionSize: manualPositionSize, fixedAmount, perSpikeShares, kellyMaxPct, kellyWinRate } = body;

    const idsToLock: string[] = spikeIds || (spikeId ? [spikeId] : []);

    if (idsToLock.length === 0) {
      return NextResponse.json(
        { success: false, error: 'spikeId or spikeIds required' },
        { status: 400 }
      );
    }

    // Load portfolio settings if portfolioId provided
    let portfolio = null;
    if (portfolioId) {
      portfolio = await prisma.portfolio.findUnique({ where: { id: portfolioId } });
    }

    const effectiveMode = mode || portfolio?.sizingMode || 'auto';
    const totalPortfolio = portfolioSize || portfolio?.portfolioSize || 100000;
    const entries = [];
    const errors = [];

    for (const id of idsToLock) {
      const spike = await prisma.spike.findUnique({ where: { id } });
      if (!spike) {
        errors.push({ id, error: 'Spike not found' });
        continue;
      }

      // Only check for duplicates within the SAME portfolio (allow same stock in different portfolios)
      const existingWhere: Record<string, unknown> = { spikeId: id, status: 'active' };
      if (portfolioId) existingWhere.portfolioId = portfolioId;
      const existing = await prisma.portfolioEntry.findFirst({ where: existingWhere });
      if (existing) {
        errors.push({ id, ticker: spike.ticker, error: 'Already locked in' });
        continue;
      }

      const atrPct = spike.atr ? (spike.atr / spike.price) * 100 : 2;
      let shares: number;
      let positionPct: number;

      if (perSpikeShares && perSpikeShares[id]) {
        // Per-spike shares specified (manual bulk)
        shares = Math.floor(perSpikeShares[id]);
        positionPct = totalPortfolio > 0 ? ((shares * spike.price) / totalPortfolio) * 100 : 0;
      } else if ((effectiveMode === 'manual' || effectiveMode === 'fixed') && manualShares) {
        // Manual or fixed mode — user specifies shares directly
        shares = Math.floor(manualShares);
        positionPct = totalPortfolio > 0 ? ((shares * spike.price) / totalPortfolio) * 100 : 0;
      } else if (effectiveMode === 'fixed' && (fixedAmount || portfolio?.fixedAmount)) {
        // Fixed mode with dollar amount — calculate shares per spike
        const amount = fixedAmount || portfolio?.fixedAmount || 2500;
        shares = Math.floor(amount / spike.price);
        positionPct = totalPortfolio > 0 ? ((shares * spike.price) / totalPortfolio) * 100 : 0;
      } else {
        // Auto mode — Kelly Criterion sizing with configurable params
        const winRate = kellyWinRate || portfolio?.kellyWinRate || 0.6;
        const maxPct = ((kellyMaxPct || portfolio?.kellyMaxPct || 2) / 100);
        const kellyFraction = calculateKellyFraction(winRate, atrPct, atrPct * 0.5);
        positionPct = Math.min(kellyFraction, maxPct) * 100;
        const positionSize = totalPortfolio * (positionPct / 100);
        shares = Math.floor(positionSize / spike.price);
      }

      if (shares <= 0) {
        errors.push({ id, ticker: spike.ticker, error: 'Position too small' });
        continue;
      }

      const entry = await prisma.portfolioEntry.create({
        data: {
          portfolioId: portfolioId || null,
          spikeId: spike.id,
          ticker: spike.ticker,
          name: spike.name,
          entryPrice: spike.price,
          entryDate: new Date(),
          shares,
          positionSize: shares * spike.price,
          positionPct,
          target3Day: spike.price * (1 + spike.predicted3Day / 100),
          target5Day: spike.price * (1 + spike.predicted5Day / 100),
          target8Day: spike.price * (1 + spike.predicted8Day / 100),
          stopLoss: spike.price * (1 - (atrPct * 2) / 100),
          status: 'active',
        },
      });
      entries.push(entry);
    }

    return NextResponse.json({
      success: true,
      data: entries.length === 1 ? entries[0] : entries,
      locked: entries.length,
      skipped: errors,
    });
  } catch (error) {
    console.error('Portfolio lock-in error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to lock in position' },
      { status: 500 }
    );
  }
}

// DELETE /api/portfolio — Remove/close a position
export async function DELETE(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { positionId, exitPrice, exitReason, sharesToSell } = await request.json();

    if (!positionId) {
      return NextResponse.json(
        { success: false, error: 'positionId required' },
        { status: 400 }
      );
    }

    const position = await prisma.portfolioEntry.findUnique({
      where: { id: positionId },
    });

    if (!position) {
      return NextResponse.json(
        { success: false, error: 'Position not found' },
        { status: 404 }
      );
    }

    if (position.status !== 'active') {
      return NextResponse.json(
        { success: false, error: 'Position is already closed' },
        { status: 400 }
      );
    }

    // If no exit price provided, try to get live price
    let finalExitPrice = exitPrice;
    if (!finalExitPrice) {
      try {
        const quotes = await getBatchQuotes([position.ticker]);
        if (quotes.length > 0) {
          finalExitPrice = quotes[0].price;
        }
      } catch {
        // Fallback below
      }
      // If live quote failed or returned empty, use entry price
      if (!finalExitPrice) {
        finalExitPrice = position.entryPrice;
      }
    }

    // Determine how many shares to sell
    const sellShares = sharesToSell ? Math.min(Math.floor(sharesToSell), position.shares) : position.shares;
    if (sellShares <= 0) {
      return NextResponse.json({ success: false, error: 'Must sell at least 1 share' }, { status: 400 });
    }

    const isPartialSell = sellShares < position.shares;
    const realizedPnl = (finalExitPrice - position.entryPrice) * sellShares;
    const realizedPnlPct = ((finalExitPrice - position.entryPrice) / position.entryPrice) * 100;

    if (isPartialSell) {
      // Partial sell: reduce shares, keep position active
      const remainingShares = position.shares - sellShares;
      const updated = await prisma.portfolioEntry.update({
        where: { id: positionId },
        data: {
          shares: remainingShares,
          positionSize: remainingShares * position.entryPrice,
        },
      });

      return NextResponse.json({
        success: true,
        partial: true,
        data: {
          ...updated,
          sharesSold: sellShares,
          remainingShares,
          realizedPnl,
          realizedPnlPct,
          exitPrice: finalExitPrice,
        },
      });
    }

    // Full close: sell all shares
    const updated = await prisma.portfolioEntry.update({
      where: { id: positionId },
      data: {
        status: 'closed',
        exitPrice: finalExitPrice,
        exitDate: new Date(),
        exitReason: exitReason || 'manual',
        realizedPnl,
        realizedPnlPct,
      },
    });

    return NextResponse.json({
      success: true,
      partial: false,
      data: {
        ...updated,
        realizedPnl,
        realizedPnlPct,
      },
    });
  } catch (error) {
    console.error('Portfolio close error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to close position' },
      { status: 500 }
    );
  }
}
