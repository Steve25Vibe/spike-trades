import { NextRequest, NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import prisma from '@/lib/db/prisma';

// GET /api/spikes/[id] — Get full analyst detail for a single spike
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  try {
    const spike = await prisma.spike.findUnique({
      where: { id },
      include: {
        report: {
          select: {
            date: true,
            marketRegime: true,
            tsxLevel: true,
            tsxChange: true,
            oilPrice: true,
            goldPrice: true,
            btcPrice: true,
            cadUsd: true,
            councilLog: true,
          },
        },
      },
    });

    if (!spike) {
      return NextResponse.json(
        { success: false, error: 'Spike not found' },
        { status: 404 }
      );
    }

    // Get the council log for this date
    const councilLog = await prisma.councilLog.findUnique({
      where: { date: spike.report.date },
    });

    // Check if already locked in
    const existingPosition = await prisma.portfolioEntry.findFirst({
      where: { spikeId: spike.id, status: 'active' },
    });

    // Get historical accuracy for this ticker (past predictions)
    const pastPredictions = await prisma.spike.findMany({
      where: {
        ticker: spike.ticker,
        actual3Day: { not: null },
      },
      select: {
        createdAt: true,
        spikeScore: true,
        predicted3Day: true,
        predicted5Day: true,
        predicted8Day: true,
        actual3Day: true,
        actual5Day: true,
        actual8Day: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    return NextResponse.json({
      success: true,
      data: {
        spike: {
          id: spike.id,
          rank: spike.rank,
          ticker: spike.ticker,
          name: spike.name,
          sector: spike.sector,
          exchange: spike.exchange,
          price: spike.price,
          volume: spike.volume,
          avgVolume: spike.avgVolume,
          marketCap: spike.marketCap,

          // Composite score
          spikeScore: spike.spikeScore,
          confidence: spike.confidence,

          // Predictions
          predicted3Day: spike.predicted3Day,
          predicted5Day: spike.predicted5Day,
          predicted8Day: spike.predicted8Day,

          // Actuals (if available)
          actual3Day: spike.actual3Day,
          actual5Day: spike.actual5Day,
          actual8Day: spike.actual8Day,

          // AI narrative
          narrative: spike.narrative,

          // Full score breakdown (all 12 factors)
          scoreBreakdown: {
            momentum: spike.momentumScore,
            volumeSurge: spike.volumeScore,
            technical: spike.technicalScore,
            macroSensitivity: spike.macroScore,
            sentiment: spike.sentimentScore,
            shortInterest: spike.shortInterest,
            volatilityAdj: spike.volatilityAdj,
            sectorRotation: spike.sectorRotation,
            patternMatch: spike.patternMatch,
            liquidityDepth: spike.liquidityDepth,
            insiderSignal: spike.insiderSignal,
            gapPotential: spike.gapPotential,
            conviction: spike.convictionScore,
          },

          // Technical indicators
          technicals: {
            rsi: spike.rsi,
            macd: spike.macd,
            macdSignal: spike.macdSignal,
            adx: spike.adx,
            bollingerUpper: spike.bollingerUpper,
            bollingerLower: spike.bollingerLower,
            ema3: spike.ema3,
            ema8: spike.ema8,
            atr: spike.atr,
          },
        },

        // Market context for this analysis date
        marketContext: {
          date: spike.report.date,
          regime: spike.report.marketRegime,
          tsxLevel: spike.report.tsxLevel,
          tsxChange: spike.report.tsxChange,
          oilPrice: spike.report.oilPrice,
          goldPrice: spike.report.goldPrice,
          btcPrice: spike.report.btcPrice,
          cadUsd: spike.report.cadUsd,
        },

        // Council audit trail
        councilAudit: councilLog
          ? {
              consensusScore: councilLog.consensusScore,
              processingTime: councilLog.processingTime,
              claudeAnalysis: councilLog.claudeAnalysis,
              grokAnalysis: councilLog.grokAnalysis,
              finalVerdict: councilLog.finalVerdict,
            }
          : null,

        // Portfolio status
        portfolio: existingPosition
          ? {
              locked: true,
              entryPrice: existingPosition.entryPrice,
              shares: existingPosition.shares,
              entryDate: existingPosition.entryDate,
            }
          : { locked: false },

        // Historical accuracy for this ticker
        tickerHistory: pastPredictions.map((p) => ({
          date: p.createdAt,
          score: p.spikeScore,
          predicted3Day: p.predicted3Day,
          predicted5Day: p.predicted5Day,
          predicted8Day: p.predicted8Day,
          actual3Day: p.actual3Day,
          actual5Day: p.actual5Day,
          actual8Day: p.actual8Day,
        })),

        // Learning adjustments (if available)
        learningAdjustments: (spike as Record<string, unknown>).learningAdjustments
          ? JSON.parse((spike as Record<string, unknown>).learningAdjustments as string)
          : null,

        // Data source attribution
        dataSources: {
          pricing: 'Financial Modeling Prep (FMP) — Real-time professional feed',
          historical: 'FMP Historical API — 90-day daily bars',
          technicals: 'Calculated in-house from historical OHLCV data (RSI-14, MACD 12/26/9, ADX-14, Bollinger 20/2, EMA 3/8/21)',
          sentiment: 'Finnhub News Sentiment API + FMP Stock News',
          shortInterest: 'Finnhub Short Interest Data',
          commodities: 'FMP Commodities & FX — USO Oil, Gold, CAD/USD',
          analysis: 'Spike Trades 4-Stage LLM Council — Sonnet (screen) → Gemini (re-score) → Opus (challenge) → Grok (final verdict)',
        },
      },
    });
  } catch (error) {
    console.error('Spike detail fetch error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch spike details' },
      { status: 500 }
    );
  }
}
