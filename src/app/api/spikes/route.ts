import { NextRequest, NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import prisma from '@/lib/db/prisma';

// GET /api/spikes — Get today's spikes (or specific date)
export async function GET(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const searchParams = request.nextUrl.searchParams;
  const dateStr = searchParams.get('date');
  const scanTypeParam = searchParams.get('scanType') || 'MORNING'; // backward compat: default MORNING
  const scanType = scanTypeParam === 'EVENING' ? 'EVENING' : 'MORNING';
  const date = dateStr ? new Date(dateStr) : new Date();

  // Normalize to date only
  const targetDate = new Date(date.toISOString().split('T')[0]);

  try {
    // Try exact date + scanType first
    let report = await prisma.dailyReport.findUnique({
      where: { date_scanType: { date: targetDate, scanType } },
      include: {
        spikes: {
          orderBy: { rank: 'asc' },
        },
      },
    });

    // If no report for today and no specific date was requested, fall back to most recent of the requested scanType
    if (!report && !dateStr) {
      report = await prisma.dailyReport.findFirst({
        where: { date: { lte: targetDate }, scanType },
        orderBy: { date: 'desc' },
        include: {
          spikes: {
            orderBy: { rank: 'asc' },
          },
        },
      });
    }

    if (!report) {
      return NextResponse.json({
        success: true,
        data: null,
        message: 'No report available for this date',
      });
    }

    // Fetch previous day's report for comparison arrows
    // Use report.date (not targetDate) so weekend/fallback views compare correctly
    // Filter by scanType so the previous-day comparison stays within the same scan family
    const prevReport = await prisma.dailyReport.findFirst({
      where: { date: { lt: report.date }, scanType },
      orderBy: { date: 'desc' },
      select: { oilPrice: true, goldPrice: true, btcPrice: true, cadUsd: true },
    });

    return NextResponse.json({
      success: true,
      data: {
        report: {
          id: report.id,
          date: report.date,
          marketRegime: report.marketRegime,
          tsxLevel: report.tsxLevel,
          tsxChange: report.tsxChange,
          oilPrice: report.oilPrice,
          goldPrice: report.goldPrice,
          btcPrice: report.btcPrice,
          cadUsd: report.cadUsd,
          csvUrl: report.csvUrl,
          prevOilPrice: prevReport?.oilPrice ?? null,
          prevGoldPrice: prevReport?.goldPrice ?? null,
          prevBtcPrice: prevReport?.btcPrice ?? null,
          prevCadUsd: prevReport?.cadUsd ?? null,
          stocksAnalyzed: (report.councilLog as any)?.universeSize || null,
        },
        spikes: report.spikes.map((s) => ({
          id: s.id,
          rank: s.rank,
          ticker: s.ticker,
          name: s.name,
          sector: s.sector,
          exchange: s.exchange,
          price: s.price,
          spikeScore: s.spikeScore,
          confidence: s.confidence,
          predicted3Day: s.predicted3Day,
          predicted5Day: s.predicted5Day,
          predicted8Day: s.predicted8Day,
          narrative: s.narrative,
          rsi: s.rsi,
          macd: s.macd,
          adx: s.adx,
          atr: s.atr,
          volume: s.volume,
          avgVolume: s.avgVolume,
          marketCap: s.marketCap,
          // Score breakdown
          momentumScore: s.momentumScore,
          volumeScore: s.volumeScore,
          technicalScore: s.technicalScore,
          macroScore: s.macroScore,
          sentimentScore: s.sentimentScore,
          actual3Day: s.actual3Day,
          actual5Day: s.actual5Day,
          actual8Day: s.actual8Day,
          // Calibration data for dual-bar confidence meter
          historicalConfidence: s.historicalConfidence,
          calibrationSamples: s.calibrationSamples,
          overconfidenceFlag: s.overconfidenceFlag,
          // v6.1 Hit Rate 2.0
          setupRateCILow: s.setupRateCILow,
          setupRateCIHigh: s.setupRateCIHigh,
          setupRateRegime: s.setupRateRegime,
          setupMedianMoveOnHits: s.setupMedianMoveOnHits,
          setupMedianMoveOnMisses: s.setupMedianMoveOnMisses,
          tickerRate: s.tickerRate,
          tickerRateSamples: s.tickerRateSamples,
          tickerRateCILow: s.tickerRateCILow,
          tickerRateCIHigh: s.tickerRateCIHigh,
          tickerMedianMoveOnHits: s.tickerMedianMoveOnHits,
          tickerMedianMoveOnMisses: s.tickerMedianMoveOnMisses,
          calibrationReconciliation: s.calibrationReconciliation,
        })),
      },
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error('Error fetching spikes:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch spikes' },
      { status: 500 }
    );
  }
}
