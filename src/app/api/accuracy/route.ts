import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth';
import prisma from '@/lib/db/prisma';

// GET /api/accuracy — Get accuracy metrics + performance vs TSX
export async function GET(request: NextRequest) {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const horizon = parseInt(request.nextUrl.searchParams.get('horizon') || '3');
  const days = parseInt(request.nextUrl.searchParams.get('days') || '90');
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

    // 2. All spikes with actuals for scatter + distribution + recent picks
    const actualField = horizon === 3 ? 'actual3Day' : horizon === 5 ? 'actual5Day' : 'actual8Day';
    const predField = horizon === 3 ? 'predicted3Day' : horizon === 5 ? 'predicted5Day' : 'predicted8Day';

    const spikesWithActuals = await prisma.spike.findMany({
      where: {
        createdAt: { gte: cutoff },
        ...(horizon === 3 ? { actual3Day: { not: null } } :
          horizon === 5 ? { actual5Day: { not: null } } :
            { actual8Day: { not: null } }),
      },
      select: {
        ticker: true, name: true, spikeScore: true, rank: true,
        predicted3Day: true, predicted5Day: true, predicted8Day: true,
        actual3Day: true, actual5Day: true, actual8Day: true,
        createdAt: true,
        report: { select: { date: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    // 3. Compute summary stats from individual spikes
    const allActuals = spikesWithActuals.map((s: any) => s[actualField] as number);
    const allPredicted = spikesWithActuals.map((s: any) => s[predField] as number);
    const avgReturn = allActuals.length > 0
      ? allActuals.reduce((a, b) => a + b, 0) / allActuals.length : 0;
    const avgPredictedReturn = allPredicted.length > 0
      ? allPredicted.reduce((a, b) => a + b, 0) / allPredicted.length : 0;

    // Best pick
    let bestPick: { ticker: string; return: number } | null = null;
    if (spikesWithActuals.length > 0) {
      const best = spikesWithActuals.reduce((best: any, s: any) =>
        (s[actualField] || 0) > (best[actualField] || 0) ? s : best
      );
      bestPick = { ticker: best.ticker, return: best[actualField] as number };
    }

    // 4. Performance comparison: Spike Picks vs TSX (fixed — same N-day windows)
    const dailyReports = await prisma.dailyReport.findMany({
      where: { date: { gte: cutoff } },
      orderBy: { date: 'asc' },
      select: {
        date: true,
        tsxLevel: true,
        spikes: {
          orderBy: { rank: 'asc' },
          take: 20,
          select: {
            ticker: true,
            rank: true,
            predicted3Day: true, predicted5Day: true, predicted8Day: true,
            actual3Day: true, actual5Day: true, actual8Day: true,
          },
        },
      },
    });

    // Build a date→tsxLevel lookup for computing N-day TSX returns
    const tsxByDate = new Map<string, number>();
    for (const r of dailyReports) {
      if (r.tsxLevel) {
        const dateKey = new Date(r.date).toISOString().split('T')[0];
        tsxByDate.set(dateKey, r.tsxLevel);
      }
    }
    const reportDates = dailyReports.map(r => new Date(r.date).toISOString().split('T')[0]);

    let cumulativeTsx = 0;
    let cumulativeAllPicks = 0;
    let cumulativeTop5 = 0;

    const performanceComparison = dailyReports.map((report, idx) => {
      // TSX N-day return: look ahead N report dates for TSX level
      const futureIdx = idx + horizon;
      if (futureIdx < dailyReports.length && report.tsxLevel && dailyReports[futureIdx].tsxLevel) {
        const tsxNDayReturn = ((dailyReports[futureIdx].tsxLevel! - report.tsxLevel) / report.tsxLevel) * 100;
        cumulativeTsx += tsxNDayReturn;
      }
      // If we can't look ahead (recent dates), TSX cumulative stays flat

      // Average actual N-day return of all 20 picks
      const spikesWithReturns = report.spikes.filter((s: any) => s[actualField] !== null);
      const avgSpikeReturn = spikesWithReturns.length > 0
        ? spikesWithReturns.reduce((sum: number, s: any) => sum + (s[actualField] || 0), 0) / spikesWithReturns.length
        : 0;
      if (spikesWithReturns.length > 0) {
        cumulativeAllPicks += avgSpikeReturn;
      }

      // Top 5 picks
      const top5 = report.spikes.slice(0, 5).filter((s: any) => s[actualField] !== null);
      const avgTop5Return = top5.length > 0
        ? top5.reduce((sum: number, s: any) => sum + (s[actualField] || 0), 0) / top5.length
        : 0;
      if (top5.length > 0) {
        cumulativeTop5 += avgTop5Return;
      }

      return {
        date: report.date,
        tsx: Math.round(cumulativeTsx * 100) / 100,
        allPicks: Math.round(cumulativeAllPicks * 100) / 100,
        top5Picks: Math.round(cumulativeTop5 * 100) / 100,
      };
    });

    // Compute alpha for summary card
    const latestPerf = performanceComparison.length > 0
      ? performanceComparison[performanceComparison.length - 1] : null;
    const alpha = latestPerf ? latestPerf.allPicks - latestPerf.tsx : 0;

    // 5. Return distribution — bucket actual returns
    const buckets = [
      { label: '< -5%', min: -Infinity, max: -5, count: 0, color: 'red' },
      { label: '-5% to -2%', min: -5, max: -2, count: 0, color: 'red' },
      { label: '-2% to 0%', min: -2, max: 0, count: 0, color: 'red' },
      { label: '0% to +2%', min: 0, max: 2, count: 0, color: 'green' },
      { label: '+2% to +5%', min: 2, max: 5, count: 0, color: 'green' },
      { label: '> +5%', min: 5, max: Infinity, count: 0, color: 'green' },
    ];

    for (const val of allActuals) {
      for (const bucket of buckets) {
        if (val >= bucket.min && val < bucket.max) {
          bucket.count++;
          break;
        }
      }
      // Edge case: exactly on boundary (e.g. 0.00 goes into 0-2%, -5.00 into -5 to -2%)
    }

    const returnDistribution = buckets.map(b => ({
      label: b.label,
      count: b.count,
      color: b.color,
    }));

    // 6. Recent picks table — last 30 with actuals
    const recentPicks = spikesWithActuals.slice(0, 30).map((s: any) => {
      const predicted = s[predField] as number;
      const actual = s[actualField] as number;
      const hit = (predicted >= 0 && actual >= 0) || (predicted < 0 && actual < 0);

      return {
        date: s.report?.date || s.createdAt,
        ticker: s.ticker,
        name: s.name,
        rank: s.rank,
        score: s.spikeScore,
        predicted: Math.round(predicted * 100) / 100,
        actual: Math.round(actual * 100) / 100,
        hit,
      };
    });

    return NextResponse.json({
      success: true,
      data: {
        summary: {
          horizon,
          totalPredictions,
          hitRate: totalPredictions > 0 ? (totalCorrect / totalPredictions) * 100 : 0,
          mae: avgMAE,
          bias: avgBias,
          avgReturn: Math.round(avgReturn * 100) / 100,
          avgPredicted: Math.round(avgPredictedReturn * 100) / 100,
          alpha: Math.round(alpha * 100) / 100,
          bestPick,
        },
        rolling: records.map((r) => ({
          date: r.date,
          hitRate: r.hitRate,
          mae: r.meanAbsError,
          predictions: r.totalPredictions,
        })),
        performanceComparison,
        returnDistribution,
        recentPicks,
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
