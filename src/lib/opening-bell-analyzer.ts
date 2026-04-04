/**
 * Opening Bell Analyzer — triggers the Python scanner and stores results in Prisma.
 */
import prisma from '@/lib/db/prisma';
import fs from 'fs';
import path from 'path';

const COUNCIL_API_URL = process.env.COUNCIL_API_URL || 'http://localhost:8100';

interface OpeningBellResult {
  success: boolean;
  report?: {
    sectorSnapshot: unknown;
    tickersScanned: number;
    scanDurationMs: number;
  };
  picks?: Array<{
    rank: number;
    ticker: string;
    name: string;
    sector?: string;
    exchange: string;
    priceAtScan: number;
    previousClose: number;
    changePercent: number;
    relativeVolume: number;
    sectorMomentum?: number;
    momentumScore: number;
    intradayTarget: number;
    keyLevel: number;
    conviction: string;
    rationale?: string;
  }>;
  tokenUsage?: { input_tokens: number; output_tokens: number };
  error?: string;
}

export async function runOpeningBellAnalysis(): Promise<{ success: boolean; picksCount: number; error?: string }> {
  console.log('[Opening Bell] Triggering scanner...');

  // Read Radar overrides (if available)
  let radarOverrides: { tickers: string[]; smart_money_scores: Record<string, number> } | null = null;
  try {
    const overridePath = path.join('/tmp', 'radar_opening_bell_overrides.json');
    if (fs.existsSync(overridePath)) {
      const raw = JSON.parse(fs.readFileSync(overridePath, 'utf-8'));
      const today = new Date().toISOString().split('T')[0];
      if (raw.date === today) {
        radarOverrides = { tickers: raw.tickers, smart_money_scores: raw.smart_money_scores };
        console.log(`[Opening Bell] Read ${raw.tickers.length} Radar overrides`);
      } else {
        console.log('[Opening Bell] Radar override file is stale — ignoring');
      }
    }
  } catch {
    console.log('[Opening Bell] No Radar overrides available');
  }

  try {
    // Step 1: Trigger the Python scanner and wait for mapped results
    const triggerRes = await fetch(`${COUNCIL_API_URL}/run-opening-bell`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!triggerRes.ok) {
      const err = await triggerRes.text();
      throw new Error(`Scanner trigger failed: ${err}`);
    }

    // Step 2: Poll for completion (max 5 minutes)
    const maxWait = 300_000;
    const pollInterval = 5_000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      await new Promise((r) => setTimeout(r, pollInterval));
      const statusRes = await fetch(`${COUNCIL_API_URL}/run-opening-bell-status`);
      const status = await statusRes.json();
      if (!status.running) break;
    }

    // Step 3: Fetch mapped results
    const resultRes = await fetch(`${COUNCIL_API_URL}/latest-opening-bell-mapped`);
    if (!resultRes.ok) {
      throw new Error(`Failed to fetch results: ${resultRes.status}`);
    }
    const result: OpeningBellResult = await resultRes.json();
    if (!result.success || !result.picks?.length) {
      throw new Error(result.error || 'No picks returned');
    }

    // Step 4: Store in database
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Halifax' });
    const reportDate = new Date(todayStr + 'T12:00:00');

    // Upsert report (in case of re-run)
    const report = await prisma.openingBellReport.upsert({
      where: { date: reportDate },
      update: {
        generatedAt: new Date(),
        sectorSnapshot: result.report?.sectorSnapshot ?? undefined,
        tickersScanned: result.report?.tickersScanned ?? 0,
        scanDurationMs: result.report?.scanDurationMs ?? 0,
      },
      create: {
        date: reportDate,
        sectorSnapshot: result.report?.sectorSnapshot ?? undefined,
        tickersScanned: result.report?.tickersScanned ?? 0,
        scanDurationMs: result.report?.scanDurationMs ?? 0,
      },
    });

    // Delete old picks for this report (if re-run)
    await prisma.openingBellPick.deleteMany({ where: { reportId: report.id } });

    // Insert new picks
    for (const pick of result.picks) {
      await prisma.openingBellPick.create({
        data: {
          reportId: report.id,
          rank: pick.rank,
          ticker: pick.ticker,
          name: pick.name,
          sector: pick.sector || null,
          exchange: pick.exchange,
          priceAtScan: pick.priceAtScan,
          previousClose: pick.previousClose,
          changePercent: pick.changePercent,
          relativeVolume: pick.relativeVolume,
          sectorMomentum: pick.sectorMomentum || null,
          momentumScore: pick.momentumScore,
          intradayTarget: pick.intradayTarget,
          keyLevel: pick.keyLevel,
          conviction: pick.conviction,
          rationale: pick.rationale || null,
          tokenUsage: result.tokenUsage ?? undefined,
        },
      });
    }

    console.log(`[Opening Bell] Saved ${result.picks.length} picks for ${todayStr}`);

    // Step 5: Save top 10 tickers for Council pre-filter override
    const overrideTickers = result.picks.map((p) => p.ticker);
    // Write to a file the Council can read
    const fs = await import('fs');
    fs.writeFileSync(
      'opening_bell_council_overrides.json',
      JSON.stringify({ date: todayStr, tickers: overrideTickers })
    );

    // Step 6: Send email to opted-in users
    try {
      const { sendOpeningBellEmail } = await import('@/lib/email/opening-bell-email');
      await sendOpeningBellEmail(result.picks, result.report?.sectorSnapshot);
    } catch (emailErr) {
      console.error('[Opening Bell] Email send failed (non-fatal):', emailErr);
    }

    return { success: true, picksCount: result.picks.length };

  } catch (error) {
    console.error('[Opening Bell] Analysis failed:', error);
    return { success: false, picksCount: 0, error: String(error) };
  }
}
