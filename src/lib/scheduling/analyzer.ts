// ============================================
// MAIN ANALYSIS ORCHESTRATOR
// Runs daily at 10:45am AST
// Calls Python Council Brain via FastAPI, then saves results to Prisma
// ============================================

import prisma from '@/lib/db/prisma';
import { sendDailySummary, sendCouncilEmail } from '@/lib/email/resend';

const COUNCIL_API_URL = process.env.COUNCIL_API_URL || 'http://localhost:8100';

interface CouncilMappedResponse {
  dailyReport: {
    date: string;
    marketRegime: string;
    tsxLevel: number;
    tsxChange: number;
    oilPrice: number;
    goldPrice: number;
    btcPrice: number;
    cadUsd: number;
    councilLog: Record<string, unknown>;
  };
  spikes: {
    rank: number;
    ticker: string;
    name: string;
    sector: string;
    exchange: string;
    price: number;
    volume: number;
    avgVolume: number;
    marketCap: number | null;
    spikeScore: number;
    momentumScore: number | null;
    volumeScore: number | null;
    technicalScore: number | null;
    macroScore: number | null;
    sentimentScore: number | null;
    shortInterest: number | null;
    volatilityAdj: number | null;
    sectorRotation: number | null;
    patternMatch: number | null;
    liquidityDepth: number | null;
    insiderSignal: number | null;
    gapPotential: number | null;
    predicted3Day: number;
    predicted5Day: number;
    predicted8Day: number;
    confidence: number;
    narrative: string;
    rsi: number | null;
    macd: number | null;
    macdSignal: number | null;
    adx: number | null;
    bollingerUpper: number | null;
    bollingerLower: number | null;
    ema3: number | null;
    ema8: number | null;
    atr: number | null;
    stopLoss: number | null;
    shares: number | null;
    positionPct: number | null;
    dollarRisk: number | null;
    convictionTier: string;
    stagesAppeared: number;
    killCondition: string | null;
    worstCase: string | null;
    forecasts: Array<{
      horizon_days: number;
      direction_probability: number;
      predicted_direction: string;
      most_likely_move_pct: number;
      price_range_low: number;
      price_range_high: number;
      clarity_decay_note: string;
    }>;
  }[];
  councilLog: Record<string, unknown>;
  riskSummary: Record<string, unknown>;
  dailyRoadmap: Record<string, unknown>;
  rawCouncilOutput: Record<string, unknown>;
}

export async function runDailyAnalysis(useCached = false): Promise<{
  success: boolean;
  spikesGenerated: number;
  error?: string;
}> {
  const startTime = Date.now();
  const today = new Date().toISOString().split('T')[0];
  console.log(`\n[Analyzer] ====== Starting daily analysis for ${today} ======`);

  try {
    // Step 1: Call the Python Council Brain via FastAPI
    // The Python brain handles ALL data fetching, scoring, and LLM analysis
    let councilResponse: Response;
    if (useCached) {
      // Use cached output from last council run (no new LLM calls)
      console.log('[Analyzer] Using cached council output...');
      councilResponse = await fetch(`${COUNCIL_API_URL}/latest-output-mapped`, {
        signal: AbortSignal.timeout(30_000),
      });
    } else {
      console.log('[Analyzer] Calling Python Council Brain...');
      councilResponse = await fetch(`${COUNCIL_API_URL}/run-council-mapped`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(3600_000), // 1 hour — full TSX pipeline takes ~45 min
      });
    }

    if (!councilResponse.ok) {
      const errText = await councilResponse.text();
      throw new Error(`Council API returned ${councilResponse.status}: ${errText}`);
    }

    const mapped: CouncilMappedResponse = await councilResponse.json();
    const { dailyReport: reportData, spikes, councilLog } = mapped;

    console.log(`[Analyzer] Council returned ${spikes.length} picks. Regime: ${reportData.marketRegime}`);

    // Step 2: Save DailyReport + Spikes to database
    console.log('[Analyzer] Saving report to database...');
    const report = await prisma.dailyReport.create({
      data: {
        date: new Date(reportData.date),
        marketRegime: reportData.marketRegime,
        tsxLevel: reportData.tsxLevel,
        tsxChange: reportData.tsxChange,
        oilPrice: reportData.oilPrice,
        goldPrice: reportData.goldPrice,
        btcPrice: reportData.btcPrice,
        cadUsd: reportData.cadUsd,
        councilLog: reportData.councilLog as any,
        spikes: {
          create: spikes.map((spike) => ({
            rank: spike.rank,
            ticker: spike.ticker,
            name: spike.name,
            sector: spike.sector || 'Unknown',
            exchange: spike.exchange,
            price: spike.price,
            volume: spike.volume,
            avgVolume: spike.avgVolume,
            marketCap: spike.marketCap,
            spikeScore: spike.spikeScore,
            momentumScore: spike.momentumScore,
            volumeScore: spike.volumeScore,
            technicalScore: spike.technicalScore,
            macroScore: spike.macroScore,
            sentimentScore: spike.sentimentScore,
            shortInterest: spike.shortInterest,
            volatilityAdj: spike.volatilityAdj,
            sectorRotation: spike.sectorRotation,
            patternMatch: spike.patternMatch,
            liquidityDepth: spike.liquidityDepth,
            insiderSignal: spike.insiderSignal,
            gapPotential: spike.gapPotential,
            predicted3Day: spike.predicted3Day,
            predicted5Day: spike.predicted5Day,
            predicted8Day: spike.predicted8Day,
            confidence: spike.confidence,
            narrative: spike.narrative || '',
            rsi: spike.rsi,
            macd: spike.macd,
            macdSignal: spike.macdSignal,
            adx: spike.adx,
            bollingerUpper: spike.bollingerUpper,
            bollingerLower: spike.bollingerLower,
            ema3: spike.ema3,
            ema8: spike.ema8,
            atr: spike.atr,
          })),
        },
      },
    });

    // Step 3: Save CouncilLog
    console.log('[Analyzer] Saving council log...');
    await prisma.councilLog.upsert({
      where: { date: new Date(reportData.date) },
      create: {
        date: new Date(reportData.date),
        claudeAnalysis: (councilLog as any).claudeAnalysis || null,
        grokAnalysis: (councilLog as any).grokAnalysis || null,
        finalVerdict: (councilLog as any).finalVerdict || null,
        consensusScore: (councilLog as any).consensusScore || null,
        processingTime: (councilLog as any).processingTime || null,
      },
      update: {
        claudeAnalysis: (councilLog as any).claudeAnalysis || null,
        grokAnalysis: (councilLog as any).grokAnalysis || null,
        finalVerdict: (councilLog as any).finalVerdict || null,
        consensusScore: (councilLog as any).consensusScore || null,
        processingTime: (councilLog as any).processingTime || null,
      },
    });

    // Step 4: Send email summary
    console.log('[Analyzer] Sending email summary...');

    // Try to send the rich HTML email from the Python renderer first
    let emailSent = false;
    try {
      const emailResponse = await fetch(`${COUNCIL_API_URL}/render-email`, {
        method: 'POST',
      });
      if (emailResponse.ok) {
        const html = await emailResponse.text();
        await sendCouncilEmail({
          date: reportData.date,
          html,
          topTicker: spikes[0]?.ticker || 'N/A',
          topScore: spikes[0]?.spikeScore || 0,
        });
        emailSent = true;
      }
    } catch (emailErr) {
      console.error('[Analyzer] Rich email failed, falling back to simple:', emailErr);
    }

    // Fallback: send simple daily summary
    if (!emailSent) {
      await sendDailySummary({
        date: today,
        topSpikes: spikes.map((s) => ({
          rank: s.rank,
          ticker: s.ticker,
          name: s.name,
          spikeScore: s.spikeScore,
          predicted3Day: s.predicted3Day,
          predicted5Day: s.predicted5Day,
          predicted8Day: s.predicted8Day,
          narrative: s.narrative || '',
        })),
        marketRegime: reportData.marketRegime,
        tsxLevel: reportData.tsxLevel,
        tsxChange: reportData.tsxChange,
      });
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Analyzer] ====== Analysis complete in ${elapsed}s. ${spikes.length} spikes generated. ======\n`);

    return { success: true, spikesGenerated: spikes.length };
  } catch (error) {
    console.error('[Analyzer] Fatal error:', error);
    return { success: false, spikesGenerated: 0, error: String(error) };
  }
}
