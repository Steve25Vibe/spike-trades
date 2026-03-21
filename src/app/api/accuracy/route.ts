import { NextRequest, NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import prisma from '@/lib/db/prisma';
import { getBatchQuotes } from '@/lib/api/fmp';

// GET /api/accuracy — Get accuracy metrics + portfolio vs market performance
export async function GET(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const horizon = parseInt(request.nextUrl.searchParams.get('horizon') || '3');
  const days = parseInt(request.nextUrl.searchParams.get('days') || '90');
  const portfolioId = request.nextUrl.searchParams.get('portfolioId');
  const cutoff = new Date(Date.now() - days * 86400000);

  try {
    // 1. Accuracy records (rolling hit rate, MAE, etc.)
    const records = await prisma.accuracyRecord.findMany({
      where: { horizon, date: { gte: cutoff } },
      orderBy: { date: 'asc' },
    });

    const totalPredictions = records.reduce((sum, r) => sum + r.totalPredictions, 0);
    const totalCorrect = records.reduce((sum, r) => sum + r.correctDirection, 0);
    const avgMAE = records.length > 0
      ? records.reduce((sum, r) => sum + r.meanAbsError, 0) / records.length : 0;
    const avgBias = records.length > 0
      ? records.reduce((sum, r) => sum + r.meanError, 0) / records.length : 0;
    const avgCorrelation = records.length > 0
      ? records.reduce((sum, r) => sum + (r.correlation || 0), 0) / records.length : 0;

    // 2. Scatter data (individual spike predicted vs actual)
    const spikesWithActuals = await prisma.spike.findMany({
      where: {
        createdAt: { gte: cutoff },
        ...(horizon === 3 ? { actual3Day: { not: null } } :
          horizon === 5 ? { actual5Day: { not: null } } :
            { actual8Day: { not: null } }),
      },
      select: {
        ticker: true, spikeScore: true,
        predicted3Day: true, predicted5Day: true, predicted8Day: true,
        actual3Day: true, actual5Day: true, actual8Day: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    // 3. Portfolio performance vs TSX — build daily cumulative return series
    // Get all daily reports with TSX data for the period
    const dailyReports = await prisma.dailyReport.findMany({
      where: { date: { gte: cutoff } },
      orderBy: { date: 'asc' },
      select: {
        date: true,
        tsxLevel: true,
        tsxChange: true,
        spikes: {
          orderBy: { rank: 'asc' },
          take: 20,
          select: {
            ticker: true,
            spikeScore: true,
            predicted3Day: true,
            actual3Day: true,
            actual5Day: true,
            actual8Day: true,
          },
        },
      },
    });

    // Build the performance comparison line chart data:
    // - "Spike Picks" line: average actual return of our Top 20 picks
    // - "TSX Composite" line: TSX daily cumulative return
    // - "Top 5 Picks" line: average actual return of only the top-5 scored picks
    let cumulativeTsx = 0;
    let cumulativeSpikePicks = 0;
    let cumulativeTop5 = 0;

    const performanceComparison = dailyReports.map((report) => {
      // TSX cumulative
      cumulativeTsx += (report.tsxChange || 0);

      // Average actual return of all 20 spike picks for this day
      const actualField = horizon === 3 ? 'actual3Day' : horizon === 5 ? 'actual5Day' : 'actual8Day';
      const spikesWithReturns = report.spikes.filter((s: any) => s[actualField] !== null);
      const avgSpikeReturn = spikesWithReturns.length > 0
        ? spikesWithReturns.reduce((sum: number, s: any) => sum + (s[actualField] || 0), 0) / spikesWithReturns.length
        : 0;
      cumulativeSpikePicks += avgSpikeReturn;

      // Top 5 picks only
      const top5 = report.spikes.slice(0, 5).filter((s: any) => s[actualField] !== null);
      const avgTop5Return = top5.length > 0
        ? top5.reduce((sum: number, s: any) => sum + (s[actualField] || 0), 0) / top5.length
        : 0;
      cumulativeTop5 += avgTop5Return;

      return {
        date: report.date,
        tsx: Math.round(cumulativeTsx * 100) / 100,
        allPicks: Math.round(cumulativeSpikePicks * 100) / 100,
        top5Picks: Math.round(cumulativeTop5 * 100) / 100,
      };
    });

    // 4. Portfolio health — value timeline for each portfolio
    // For each portfolio, build a chronological series of events (entries + exits)
    // to show portfolio value over time
    const allPortfolios = await prisma.portfolio.findMany({
      select: { id: true, name: true, portfolioSize: true },
      orderBy: { createdAt: 'asc' },
    });

    const portfolioHealthMap: Record<string, Array<{ date: Date | string; totalValue: number; totalInvested: number; realizedPnl: number; portfolioName: string }>> = {};

    for (const pf of allPortfolios) {
      const entries = await prisma.portfolioEntry.findMany({
        where: { portfolioId: pf.id },
        orderBy: { entryDate: 'asc' },
        select: {
          ticker: true,
          entryPrice: true,
          exitPrice: true,
          entryDate: true,
          exitDate: true,
          shares: true,
          positionSize: true,
          realizedPnl: true,
          status: true,
        },
      });

      if (entries.length === 0) continue;

      // Collect all event dates (entries + exits)
      const events: Array<{ date: Date; type: 'entry' | 'exit'; ticker: string; shares: number; entryPrice: number; exitPrice?: number; positionSize: number; realizedPnl?: number }> = [];

      for (const e of entries) {
        events.push({
          date: new Date(e.entryDate),
          type: 'entry',
          ticker: e.ticker,
          shares: e.shares,
          entryPrice: e.entryPrice,
          positionSize: e.positionSize,
        });
        if (e.exitDate && (e.status === 'closed' || e.status === 'stopped')) {
          events.push({
            date: new Date(e.exitDate),
            type: 'exit',
            ticker: e.ticker,
            shares: e.shares,
            entryPrice: e.entryPrice,
            exitPrice: e.exitPrice || e.entryPrice,
            positionSize: e.positionSize,
            realizedPnl: e.realizedPnl || 0,
          });
        }
      }

      events.sort((a, b) => a.date.getTime() - b.date.getTime());

      // Walk through events to build value timeline
      let totalInvested = 0;
      let cumulativeRealized = 0;
      const timeline: typeof portfolioHealthMap[string] = [];

      for (const ev of events) {
        if (ev.type === 'entry') {
          totalInvested += ev.positionSize;
        } else {
          totalInvested -= ev.positionSize;
          cumulativeRealized += (ev.realizedPnl || 0);
        }
        timeline.push({
          date: ev.date,
          totalValue: totalInvested + cumulativeRealized,
          totalInvested,
          realizedPnl: Math.round(cumulativeRealized * 100) / 100,
          portfolioName: pf.name,
        });
      }

      // Add current point for active positions with live prices
      const activeEntries = entries.filter((e) => e.status === 'active');
      if (activeEntries.length > 0) {
        const activeTickers = [...new Set(activeEntries.map((e) => e.ticker))];
        try {
          const quotes = await getBatchQuotes(activeTickers);
          const priceMap = new Map(quotes.map((q) => [q.ticker, q.price]));
          let currentActiveValue = 0;
          for (const e of activeEntries) {
            const livePrice = priceMap.get(e.ticker) || e.entryPrice;
            currentActiveValue += livePrice * e.shares;
          }
          timeline.push({
            date: new Date(),
            totalValue: currentActiveValue + cumulativeRealized,
            totalInvested: activeEntries.reduce((s, e) => s + e.positionSize, 0),
            realizedPnl: Math.round(cumulativeRealized * 100) / 100,
            portfolioName: pf.name,
          });
        } catch {
          // Live quotes failed — use entry prices as fallback
          const fallbackValue = activeEntries.reduce((s, e) => s + e.positionSize, 0);
          timeline.push({
            date: new Date(),
            totalValue: fallbackValue + cumulativeRealized,
            totalInvested: fallbackValue,
            realizedPnl: Math.round(cumulativeRealized * 100) / 100,
            portfolioName: pf.name,
          });
        }
      }

      if (timeline.length > 0) {
        portfolioHealthMap[pf.id] = timeline;
      }
    }

    const portfolioHealth = Object.entries(portfolioHealthMap).map(([id, timeline]) => ({
      portfolioId: id,
      portfolioName: timeline[0]?.portfolioName || 'Unknown',
      timeline: timeline.map((t) => ({
        date: t.date,
        totalValue: Math.round(t.totalValue * 100) / 100,
        totalInvested: Math.round(t.totalInvested * 100) / 100,
        realizedPnl: t.realizedPnl,
      })),
    }));

    // 5. Daily predicted vs actual line chart (not scatter — line comparison)
    const dailyPredVsActual = dailyReports.map((report) => {
      const actualField = horizon === 3 ? 'actual3Day' : horizon === 5 ? 'actual5Day' : 'actual8Day';
      const predField = horizon === 3 ? 'predicted3Day' : horizon === 5 ? 'predicted5Day' : 'predicted8Day';

      const withActuals = report.spikes.filter((s: any) => s[actualField] !== null);
      const avgPredicted = withActuals.length > 0
        ? withActuals.reduce((sum: number, s: any) => sum + (s[predField] || 0), 0) / withActuals.length : null;
      const avgActual = withActuals.length > 0
        ? withActuals.reduce((sum: number, s: any) => sum + (s[actualField] || 0), 0) / withActuals.length : null;

      return {
        date: report.date,
        predicted: avgPredicted !== null ? Math.round(avgPredicted * 100) / 100 : null,
        actual: avgActual !== null ? Math.round(avgActual * 100) / 100 : null,
      };
    }).filter((d) => d.predicted !== null);

    return NextResponse.json({
      success: true,
      data: {
        summary: {
          horizon,
          totalPredictions,
          hitRate: totalPredictions > 0 ? (totalCorrect / totalPredictions) * 100 : 0,
          mae: avgMAE,
          bias: avgBias,
          correlation: avgCorrelation,
        },
        rolling: records.map((r) => ({
          date: r.date,
          hitRate: r.hitRate,
          mae: r.meanAbsError,
          predictions: r.totalPredictions,
        })),
        scatterData: spikesWithActuals.map((s) => ({
          ticker: s.ticker,
          score: s.spikeScore,
          predicted: horizon === 3 ? s.predicted3Day : horizon === 5 ? s.predicted5Day : s.predicted8Day,
          actual: horizon === 3 ? s.actual3Day : horizon === 5 ? s.actual5Day : s.actual8Day,
          date: s.createdAt,
        })),
        // NEW: Performance comparison line chart data
        performanceComparison,
        // Portfolio health timelines (per-portfolio value over time)
        portfolioHealth,
        // NEW: Daily predicted vs actual averages (line chart, not scatter)
        dailyPredVsActual,
      },
    });
  } catch (error) {
    console.error('Accuracy fetch error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch accuracy data' },
      { status: 500 }
    );
  }
}
