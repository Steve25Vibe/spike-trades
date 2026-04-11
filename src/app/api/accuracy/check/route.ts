import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';
import { getBatchQuotes } from '@/lib/api/fmp';
import { subtractTradingDays, getTodayAST } from '@/lib/utils';

// POST /api/accuracy/check — Runs daily at 4:30 PM AST after market close
// Back-fills actual3Day / actual5Day / actual8Day on historical spikes
// and populates AccuracyRecord for the accuracy charts.
// Uses a SWEEP approach: fills ALL unfilled spikes where enough trading days
// have elapsed, not just one specific date. This ensures catch-up if a
// previous cron run was missed.
export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.SESSION_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const today = getTodayAST();
    let filled = 0;

    // ---- 1. Sweep all unfilled actuals for each scanType + horizon ----
    for (const scanType of ['MORNING', 'EVENING'] as const) {
    for (const horizon of [3, 5, 8] as const) {
      // Cutoff: any report from this date or earlier has had enough trading days
      const cutoffDate = subtractTradingDays(today, horizon);
      const cutoffDateOnly = new Date(cutoffDate.toISOString().split('T')[0]);

      const actualField =
        horizon === 3
          ? 'actual3Day'
          : horizon === 5
            ? 'actual5Day'
            : 'actual8Day';

      // Find ALL spikes with missing actuals where enough time has passed
      const spikes = await prisma.spike.findMany({
        where: {
          report: { date: { lte: cutoffDateOnly } },
          scanType,
          [actualField]: null,
        },
        select: {
          id: true,
          ticker: true,
          price: true,
          report: { select: { date: true } },
        },
      });

      if (spikes.length === 0) continue;

      // Fetch current (closing) prices for those tickers
      const tickers = Array.from(new Set(spikes.map((s) => s.ticker)));
      const quotes = await getBatchQuotes(tickers);
      const priceMap = new Map(quotes.map((q) => [q.ticker, q.price]));

      // Track which report dates got fills for metrics computation
      const filledReportDates = new Set<string>();

      const spikeUpdates = [];
      for (const spike of spikes) {
        const closingPrice = priceMap.get(spike.ticker);
        if (closingPrice === undefined || spike.price === 0) continue;

        const actualReturn =
          ((closingPrice - spike.price) / spike.price) * 100;

        spikeUpdates.push(
          prisma.spike.update({
            where: { id: spike.id },
            data: { [actualField]: Math.round(actualReturn * 100) / 100 },
          })
        );
        filled++;
        filledReportDates.add(spike.report.date.toISOString().split('T')[0]);
      }
      if (spikeUpdates.length > 0) {
        await prisma.$transaction(spikeUpdates);
      }

      // ---- 2. Compute accuracy metrics for each report date that got fills ----
      const predField =
        horizon === 3
          ? 'predicted3Day'
          : horizon === 5
            ? 'predicted5Day'
            : 'predicted8Day';

      for (const dateStr of filledReportDates) {
        const dateOnly = new Date(dateStr);

        const completedSpikes = await prisma.spike.findMany({
          where: {
            report: { date: dateOnly },
            scanType,
            [actualField]: { not: null },
          },
          select: {
            predicted3Day: true,
            predicted5Day: true,
            predicted8Day: true,
            actual3Day: true,
            actual5Day: true,
            actual8Day: true,
          },
        });

        if (completedSpikes.length === 0) continue;

        let correctDirection = 0;
        let totalAbsError = 0;
        let totalError = 0;
        let sumPred = 0;
        let sumActual = 0;
        let sumPredActual = 0;
        let sumPred2 = 0;
        let sumActual2 = 0;

        for (const s of completedSpikes) {
          const pred = (s as any)[predField] as number;
          const actual = (s as any)[actualField] as number;

          if (
            (pred > 0 && actual > 0) ||
            (pred < 0 && actual < 0) ||
            (pred === 0 && actual === 0)
          ) {
            correctDirection++;
          }

          const err = actual - pred;
          totalAbsError += Math.abs(err);
          totalError += err;
          sumPred += pred;
          sumActual += actual;
          sumPredActual += pred * actual;
          sumPred2 += pred * pred;
          sumActual2 += actual * actual;
        }

        const n = completedSpikes.length;
        const mae = totalAbsError / n;
        const meanError = totalError / n;
        const hitRate = (correctDirection / n) * 100;
        const avgPred = sumPred / n;
        const avgActual = sumActual / n;

        // Pearson correlation
        const numerator = sumPredActual - n * avgPred * avgActual;
        const denomA = Math.sqrt(sumPred2 - n * avgPred * avgPred);
        const denomB = Math.sqrt(sumActual2 - n * avgActual * avgActual);
        const correlation =
          denomA > 0 && denomB > 0 ? numerator / (denomA * denomB) : 0;

        const metrics = {
          totalPredictions: n,
          correctDirection,
          meanAbsError: Math.round(mae * 1000) / 1000,
          meanError: Math.round(meanError * 1000) / 1000,
          hitRate: Math.round(hitRate * 10) / 10,
          avgPredicted: Math.round(avgPred * 100) / 100,
          avgActual: Math.round(avgActual * 100) / 100,
          correlation: Math.round(correlation * 1000) / 1000,
        };

        await prisma.accuracyRecord.upsert({
          where: { date_horizon_scanType: { date: dateOnly, horizon, scanType } },
          create: { date: dateOnly, horizon, scanType, ...metrics },
          update: metrics,
        });
      }
    }
    } // end scanType loop

    console.log(`[Accuracy] Back-filled ${filled} actual returns`);
    return NextResponse.json({ success: true, filled });
  } catch (error) {
    console.error('[Accuracy] Check error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}
