import { NextRequest, NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import prisma from '@/lib/db/prisma';

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

    // 4. Portfolio closed trades — actual P&L history for the "Your Portfolio" line
    const closedTradesWhere: Record<string, unknown> = {
      status: { in: ['closed', 'stopped'] },
      exitDate: { gte: cutoff },
    };
    if (portfolioId) closedTradesWhere.portfolioId = portfolioId;

    const closedTrades = await prisma.portfolioEntry.findMany({
      where: closedTradesWhere,
      orderBy: { exitDate: 'asc' },
      select: {
        ticker: true,
        entryPrice: true,
        exitPrice: true,
        realizedPnlPct: true,
        exitDate: true,
        shares: true,
        positionSize: true,
        realizedPnl: true,
      },
    });

    let cumulativePortfolio = 0;
    const portfolioReturns = closedTrades.map((t) => {
      cumulativePortfolio += (t.realizedPnlPct || 0);
      return {
        date: t.exitDate,
        ticker: t.ticker,
        returnPct: t.realizedPnlPct,
        cumulative: Math.round(cumulativePortfolio * 100) / 100,
        pnl: t.realizedPnl,
      };
    });

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
        // NEW: Portfolio closed-trade cumulative returns
        portfolioReturns,
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
