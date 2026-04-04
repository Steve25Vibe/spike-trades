/**
 * Radar Analyzer — triggers the Python Radar scanner and stores results in Prisma.
 * Pattern follows opening-bell-analyzer.ts exactly.
 */
import prisma from '@/lib/db/prisma';
import fs from 'fs';
import path from 'path';
import { sendRadarEmail } from '@/lib/email/radar-email';

const COUNCIL_API_URL = process.env.COUNCIL_API_URL || 'http://localhost:8100';

interface RadarPickData {
  rank: number;
  ticker: string;
  company_name: string;
  sector: string;
  exchange: string;
  price: number;
  smart_money_score: number;
  score_breakdown: {
    catalyst_strength: number;
    news_sentiment: number;
    technical_setup: number;
    volume_signals: number;
    sector_alignment: number;
  };
  top_catalyst: string;
  rationale: string;
}

interface RadarResultData {
  run_id: string;
  tickers_scanned: number;
  tickers_flagged: number;
  picks: RadarPickData[];
  scan_duration_seconds: number;
  token_usage: Record<string, number>;
  error?: string;
}

export async function runRadarAnalysis(): Promise<{ success: boolean; picksCount: number; error?: string }> {
  console.log('[Radar] Triggering scanner...');

  try {
    // Step 1: Trigger Python FastAPI (returns immediately, runs in background)
    const triggerRes = await fetch(`${COUNCIL_API_URL}/run-radar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!triggerRes.ok) {
      const errText = await triggerRes.text();
      throw new Error(`Radar trigger failed: ${errText}`);
    }

    // Step 2: Poll for completion (max 6 minutes)
    const maxWait = 360_000;
    const pollInterval = 5_000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      await new Promise((r) => setTimeout(r, pollInterval));
      try {
        const statusRes = await fetch(`${COUNCIL_API_URL}/run-radar-status`);
        const status = await statusRes.json();
        if (!status.running) break;
      } catch (pollErr) {
        console.warn('[Radar] Status poll failed, retrying...', pollErr);
      }
    }

    // Step 3: Fetch results
    const resultRes = await fetch(`${COUNCIL_API_URL}/latest-radar-output`);
    if (!resultRes.ok) {
      throw new Error(`Failed to fetch Radar results: ${resultRes.status}`);
    }
    const result: RadarResultData = await resultRes.json();

    if (result.error) {
      throw new Error(result.error);
    }

    if (!result.picks || result.picks.length === 0) {
      console.log('[Radar] No picks flagged — quiet overnight');
      // Still save the report (0 picks is valid)
    }

    // Step 2: Save to database
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Halifax' });
    const today = new Date(todayStr + 'T12:00:00');

    // Delete existing report for today (idempotent re-run)
    await prisma.radarPick.deleteMany({
      where: { report: { date: today } },
    });
    await prisma.radarReport.deleteMany({
      where: { date: today },
    });

    const report = await prisma.radarReport.create({
      data: {
        date: today,
        tickersScanned: result.tickers_scanned,
        tickersFlagged: result.tickers_flagged,
        scanDurationMs: Math.round(result.scan_duration_seconds * 1000),
        tokenUsage: result.token_usage || {},
        picks: {
          create: (result.picks || []).map((pick) => ({
            rank: pick.rank,
            ticker: pick.ticker,
            name: pick.company_name || '',
            sector: pick.sector || null,
            exchange: pick.exchange || 'TSX',
            priceAtScan: pick.price,
            smartMoneyScore: pick.smart_money_score,
            catalystStrength: pick.score_breakdown.catalyst_strength,
            newsSentiment: pick.score_breakdown.news_sentiment,
            technicalSetup: pick.score_breakdown.technical_setup,
            volumeSignals: pick.score_breakdown.volume_signals,
            sectorAlignment: pick.score_breakdown.sector_alignment,
            rationale: pick.rationale || null,
            topCatalyst: pick.top_catalyst || null,
          })),
        },
      },
    });

    console.log(`[Radar] Saved ${result.picks?.length || 0} picks to database`);

    // Step 3: Write override file for Opening Bell
    const overrideTickers = (result.picks || []).map((p) => p.ticker);
    const smartMoneyScores: Record<string, number> = {};
    for (const p of result.picks || []) {
      smartMoneyScores[p.ticker] = p.smart_money_score;
    }

    const overridePath = path.join('/tmp', 'radar_opening_bell_overrides.json');
    fs.writeFileSync(overridePath, JSON.stringify({
      date: today.toISOString().split('T')[0],
      tickers: overrideTickers,
      smart_money_scores: smartMoneyScores,
    }));
    console.log(`[Radar] Wrote override file with ${overrideTickers.length} tickers`);

    // Step 4: Send email to opted-in users
    try {
      await sendRadarEmail(
        (result.picks || []).map((p) => ({
          rank: p.rank,
          ticker: p.ticker,
          name: p.company_name,
          smartMoneyScore: p.smart_money_score,
          topCatalyst: p.top_catalyst,
        })),
        today.toISOString().split('T')[0],
      );
    } catch (emailErr) {
      console.error('[Radar] Email failed (non-fatal):', emailErr);
    }

    return { success: true, picksCount: result.picks?.length || 0 };
  } catch (error) {
    console.error('[Radar] Error:', error);
    return { success: false, picksCount: 0, error: String(error) };
  }
}
