import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth';
import prisma from '@/lib/db/prisma';

// GET /api/accuracy — All-horizon accuracy data (no toggle needed)
export async function GET(request: NextRequest) {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const days = parseInt(request.nextUrl.searchParams.get('days') || '90');
  const cutoff = new Date(Date.now() - days * 86400000);

  try {
    // 1. Get all daily reports with spikes
    const dailyReports = await prisma.dailyReport.findMany({
      where: { date: { gte: cutoff } },
      orderBy: { date: 'asc' },
      select: {
        date: true,
        spikes: {
          orderBy: { rank: 'asc' },
          take: 20,
          select: {
            ticker: true, name: true, rank: true, spikeScore: true,
            predicted3Day: true, predicted5Day: true, predicted8Day: true,
            actual3Day: true, actual5Day: true, actual8Day: true,
          },
        },
      },
    });

    // 2. Build candlestick data per report date + cumulative index
    let index3 = 100, index5 = 100, index8 = 100;
    const candlestickData = dailyReports.map((report) => {
      const point: Record<string, unknown> = {
        date: report.date,
      };

      for (const [horizon, prefix, idxKey] of [
        [3, '3', 'index3'] as const,
        [5, '5', 'index5'] as const,
        [8, '8', 'index8'] as const,
      ]) {
        const actualField = `actual${horizon}Day` as 'actual3Day' | 'actual5Day' | 'actual8Day';
        const withActuals = report.spikes.filter((s) => s[actualField] !== null);

        if (withActuals.length > 0) {
          const actuals = withActuals.map((s) => s[actualField] as number);
          const avg = actuals.reduce((a, b) => a + b, 0) / actuals.length;
          const min = Math.min(...actuals);
          const max = Math.max(...actuals);

          point[`avg${prefix}`] = Math.round(avg * 100) / 100;
          point[`min${prefix}`] = Math.round(min * 100) / 100;
          point[`max${prefix}`] = Math.round(max * 100) / 100;

          // Update cumulative index
          if (horizon === 3) { index3 *= (1 + avg / 100); point.index3 = Math.round(index3 * 100) / 100; }
          if (horizon === 5) { index5 *= (1 + avg / 100); point.index5 = Math.round(index5 * 100) / 100; }
          if (horizon === 8) { index8 *= (1 + avg / 100); point.index8 = Math.round(index8 * 100) / 100; }
        } else {
          point[`avg${prefix}`] = null;
          point[`min${prefix}`] = null;
          point[`max${prefix}`] = null;
          // Carry forward last index value
          if (horizon === 3) point.index3 = Math.round(index3 * 100) / 100;
          if (horizon === 5) point.index5 = Math.round(index5 * 100) / 100;
          if (horizon === 8) point.index8 = Math.round(index8 * 100) / 100;
        }
      }

      return point;
    });

    // 3. Build scorecards per horizon
    const scorecards = [3, 5, 8].map((horizon) => {
      const actualField = `actual${horizon}Day` as 'actual3Day' | 'actual5Day' | 'actual8Day';
      const predField = `predicted${horizon}Day` as 'predicted3Day' | 'predicted5Day' | 'predicted8Day';

      let wins = 0, losses = 0, totalReturn = 0, count = 0;

      for (const report of dailyReports) {
        for (const s of report.spikes) {
          const actual = s[actualField];
          if (actual === null) continue;
          count++;
          totalReturn += actual;
          const pred = s[predField] as number;
          const hit = (pred >= 0 && actual >= 0) || (pred < 0 && actual < 0);
          if (hit) wins++; else losses++;
        }
      }

      const indexVal = horizon === 3 ? index3 : horizon === 5 ? index5 : index8;

      return {
        horizon,
        wins,
        losses,
        total: count,
        winRate: count > 0 ? Math.round((wins / count) * 1000) / 10 : null,
        avgReturn: count > 0 ? Math.round((totalReturn / count) * 100) / 100 : null,
        indexValue: Math.round(indexVal * 100) / 100,
        hasData: count > 0,
      };
    });

    // 4. Recent picks — all horizons, sorted alphabetically
    const allSpikes = dailyReports.flatMap((report) =>
      report.spikes.map((s) => ({
        date: report.date,
        ticker: s.ticker,
        name: s.name,
        rank: s.rank,
        score: s.spikeScore,
        predicted3: s.predicted3Day,
        predicted5: s.predicted5Day,
        predicted8: s.predicted8Day,
        actual3: s.actual3Day,
        actual5: s.actual5Day,
        actual8: s.actual8Day,
      }))
    );

    // Sort alphabetically by ticker, then by date desc within same ticker
    allSpikes.sort((a, b) => {
      const tickerCmp = a.ticker.localeCompare(b.ticker);
      if (tickerCmp !== 0) return tickerCmp;
      return new Date(b.date).getTime() - new Date(a.date).getTime();
    });

    return NextResponse.json({
      success: true,
      data: {
        candlestickData,
        scorecards,
        recentPicks: allSpikes,
        indexValues: {
          day3: Math.round(index3 * 100) / 100,
          day5: Math.round(index5 * 100) / 100,
          day8: Math.round(index8 * 100) / 100,
        },
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
