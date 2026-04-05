import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';
import { getBatchQuotes } from '@/lib/api/fmp';
import { subtractTradingDays, getTodayAST, getTodayASTString } from '@/lib/utils';

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
    const todayStr = getTodayASTString();
    const today = getTodayAST();
    let filled = 0;

    // ---- 1. Sweep all unfilled actuals for each horizon ----
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
          where: { date_horizon: { date: dateOnly, horizon } },
          create: { date: dateOnly, horizon, ...metrics },
          update: metrics,
        });
      }
    }

    // ── Opening Bell Accuracy Backfill ──
    let obFilled = 0;
    try {
      // Find Opening Bell picks with missing actuals
      const obPicks = await prisma.openingBellPick.findMany({
        where: {
          report: { date: { lte: new Date(todayStr + 'T23:59:59') } },
          actualHigh: null,
        },
        select: {
          id: true,
          ticker: true,
          priceAtScan: true,
          intradayTarget: true,
          keyLevel: true,
          report: { select: { date: true } },
        },
      });

      if (obPicks.length > 0) {
        const obTickers = Array.from(new Set(obPicks.map((p) => p.ticker)));
        const quotes = await getBatchQuotes(obTickers);
        const quoteMap = new Map(quotes.map((q) => [q.ticker, q]));

        const obUpdates = [];
        for (const pick of obPicks) {
          const q = quoteMap.get(pick.ticker);
          if (!q) continue;

          const actualHigh = q.high || q.price;
          const actualClose = q.price;
          const targetHit = actualHigh >= pick.intradayTarget;
          const keyLevelBroken = q.low != null ? q.low <= pick.keyLevel : false;

          obUpdates.push(
            prisma.openingBellPick.update({
              where: { id: pick.id },
              data: { actualHigh, actualClose, targetHit, keyLevelBroken },
            })
          );
          obFilled++;
        }
        if (obUpdates.length > 0) {
          await prisma.$transaction(obUpdates);
        }
      }
    } catch (obErr) {
      console.error('[Accuracy] Opening Bell backfill error (non-fatal):', obErr);
    }

    // ── Radar accuracy backfill ──
    let radarFilled = 0;
    try {
      const unfilled = await prisma.radarPick.findMany({
        where: {
          report: { date: { lte: new Date(todayStr + 'T23:59:59') } },
          actualOpenPrice: null,
        },
        select: {
          id: true,
          ticker: true,
          priceAtScan: true,
          report: { select: { date: true } },
        },
      });

      if (unfilled.length > 0) {
        const radarTickers = [...new Set(unfilled.map(p => p.ticker))];
        const radarQuotes = await getBatchQuotes(radarTickers);
        const radarQuoteMap = new Map(radarQuotes.map(q => [q.ticker, q]));

        const radarUpdates = [];
        for (const pick of unfilled) {
          const q = radarQuoteMap.get(pick.ticker);
          if (!q) continue;

          const actualOpen = q.open || q.price;
          const actualOpenChangePct = pick.priceAtScan > 0
            ? ((actualOpen - pick.priceAtScan) / pick.priceAtScan) * 100
            : 0;
          const openMoveCorrect = actualOpenChangePct > 0;

          radarUpdates.push(
            prisma.radarPick.update({
              where: { id: pick.id },
              data: {
                actualOpenPrice: actualOpen,
                actualOpenChangePct: parseFloat(actualOpenChangePct.toFixed(4)),
                actualDayHigh: q.high || q.price,
                actualDayClose: q.price,
                openMoveCorrect,
              },
            })
          );
          radarFilled++;
        }
        if (radarUpdates.length > 0) {
          await prisma.$transaction(radarUpdates);
        }
      }
    } catch (radarErr) {
      console.error('[Accuracy] Radar backfill error (non-fatal):', radarErr);
    }

    // ── Update Radar pipeline flags ──
    try {
      const pipelineDate = today;

      // Which Radar tickers passed Opening Bell today?
      const obPipePicks = await prisma.openingBellPick.findMany({
        where: { report: { date: pipelineDate } },
        select: { ticker: true },
      });
      const obTickerSet = new Set(obPipePicks.map(p => p.ticker));

      // Which Radar tickers passed Today's Spikes today?
      const spikePipePicks = await prisma.spike.findMany({
        where: { report: { date: pipelineDate } },
        select: { ticker: true },
      });
      const spikeTickerSet = new Set(spikePipePicks.map(p => p.ticker));

      // Update Radar picks with pipeline status
      const radarPipePicks = await prisma.radarPick.findMany({
        where: { report: { date: pipelineDate } },
        select: { id: true, ticker: true },
      });

      const pipelineUpdates = radarPipePicks.map((rp) =>
        prisma.radarPick.update({
          where: { id: rp.id },
          data: {
            passedOpeningBell: obTickerSet.has(rp.ticker),
            passedSpikes: spikeTickerSet.has(rp.ticker),
          },
        })
      );
      if (pipelineUpdates.length > 0) {
        await prisma.$transaction(pipelineUpdates);
      }
    } catch (flagErr) {
      console.error('[Accuracy] Radar pipeline flag update error (non-fatal):', flagErr);
    }

    console.log(`[Accuracy] Back-filled ${filled} actual returns, ${obFilled} Opening Bell picks, ${radarFilled} Radar picks`);
    return NextResponse.json({ success: true, filled, openingBellFilled: obFilled, radarFilled });
  } catch (error) {
    console.error('[Accuracy] Check error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}
