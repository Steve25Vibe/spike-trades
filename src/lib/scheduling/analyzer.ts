// ============================================
// MAIN ANALYSIS ORCHESTRATOR
// Runs daily at 11:15am ADT
// Calls Python Council Brain via FastAPI, then saves results to Prisma
// ============================================

import { Prisma } from '@prisma/client';
import prisma from '@/lib/db/prisma';
import { sendDailySummary, sendCouncilEmail, sendEveningPreviewEmail } from '@/lib/email/resend';

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
    convictionScore: number | null;
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
    institutionalConvictionScore: number | null;
    historicalConfidence: number | null;
    calibrationSamples: number | null;
    overconfidenceFlag: boolean | null;
    learningAdjustments: string | null;
  }[];
  councilLog: Record<string, unknown>;
  riskSummary: Record<string, unknown>;
  dailyRoadmap: Record<string, unknown>;
  rawCouncilOutput: Record<string, unknown>;
}

export async function runDailyAnalysis(useCached = false, trigger = 'scheduled'): Promise<{
  success: boolean;
  spikesGenerated: number;
  error?: string;
}> {
  const startTime = Date.now();
  // Use AST/ADT (America/Halifax) for date to match the trading day
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Halifax' });
  console.log(`\n[Analyzer] ====== Starting daily analysis for ${today} ======`);

  try {
    // Step 1: Call the Python Council Brain via FastAPI
    // The Python brain handles ALL data fetching, scoring, and LLM analysis
    let councilResponse: Response;
    if (useCached) {
      // Use cached output from last council run (no new LLM calls)
      console.log('[Analyzer] Using cached council output...');
      const http = await import('http');
      councilResponse = await new Promise<Response>((resolve, reject) => {
        const url = new URL(`${COUNCIL_API_URL}/latest-output-mapped`);
        const req = http.request(
          {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'GET',
            timeout: 60_000, // 1 minute timeout for cached data
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
              const body = Buffer.concat(chunks).toString();
              resolve(new Response(body, {
                status: res.statusCode || 500,
                headers: res.headers as Record<string, string>,
              }));
            });
            res.on('error', reject);
          },
        );
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Cached council fetch timed out after 1 minute'));
        });
        req.on('error', reject);
        req.end();
      });
    } else {
      console.log('[Analyzer] Calling Python Council Brain...');
      // Use http module directly to avoid undici's default headersTimeout (300s)
      // The council pipeline takes 45-60 minutes with no response until complete
      const http = await import('http');
      councilResponse = await new Promise<Response>((resolve, reject) => {
        const url = new URL(`${COUNCIL_API_URL}/run-council-mapped?trigger=${trigger}`);
        const req = http.request(
          {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            timeout: 3_600_000, // 1 hour socket timeout
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
              const body = Buffer.concat(chunks).toString();
              resolve(new Response(body, {
                status: res.statusCode || 500,
                headers: res.headers as Record<string, string>,
              }));
            });
            res.on('error', reject);
          },
        );
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Council request timed out after 1 hour'));
        });
        req.on('error', reject);
        req.write(JSON.stringify({}));
        req.end();
      });
    }

    if (!councilResponse.ok) {
      const errText = await councilResponse.text();
      throw new Error(`Council API returned ${councilResponse.status}: ${errText}`);
    }

    const mapped: CouncilMappedResponse = await councilResponse.json();
    const { dailyReport: reportData, spikes, councilLog } = mapped;

    console.log(`[Analyzer] Council returned ${spikes.length} picks. Regime: ${reportData.marketRegime}`);

    // Step 2: Save DailyReport + Spikes to database (upsert to handle re-runs)
    console.log('[Analyzer] Saving report to database...');
    // Parse date string as local date (not UTC) to avoid timezone shift
    // "2025-03-19" must be stored as March 19, not shifted to March 18 via UTC
    const [year, month, day] = reportData.date.split('-').map(Number);
    const reportDate = new Date(year, month - 1, day);

    // Check if a report already exists for this date
    // v6.1.0: the unique constraint widened to (date, scanType). The legacy
    // morning path implicitly uses scanType='MORNING'.
    const existingReport = await prisma.dailyReport.findUnique({
      where: { date_scanType: { date: reportDate, scanType: 'MORNING' } },
      select: { id: true },
    });

    // If re-running, delete old spikes (clearing portfolio refs first)
    if (existingReport) {
      await prisma.portfolioEntry.deleteMany({
        where: { spike: { reportId: existingReport.id } },
      });
      await prisma.spike.deleteMany({
        where: { reportId: existingReport.id },
      });
    }

    const reportFields = {
      marketRegime: reportData.marketRegime,
      tsxLevel: reportData.tsxLevel,
      tsxChange: reportData.tsxChange,
      oilPrice: reportData.oilPrice,
      goldPrice: reportData.goldPrice,
      btcPrice: reportData.btcPrice,
      cadUsd: reportData.cadUsd,
      councilLog: reportData.councilLog as any,
    };

    const spikeData = spikes.map((spike) => ({
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
      convictionScore: spike.convictionScore,
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
      // IIC for third bar on SpikeCard
      institutionalConvictionScore: spike.institutionalConvictionScore,
      // Calibration data for dual-bar confidence meter
      historicalConfidence: spike.historicalConfidence,
      calibrationSamples: spike.calibrationSamples,
      overconfidenceFlag: spike.overconfidenceFlag,
      learningAdjustments: spike.learningAdjustments,
    }));

    // v6.1.0: include scanType='MORNING' for the legacy morning path
    const report = await prisma.dailyReport.upsert({
      where: { date_scanType: { date: reportDate, scanType: 'MORNING' } },
      create: {
        date: reportDate,
        scanType: 'MORNING',
        ...reportFields,
        spikes: { create: spikeData },
      },
      update: {
        ...reportFields,
        spikes: { create: spikeData },
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
    // Degraded-run gate (2026-04-09): if any LLM stage was skipped due to timeout
    // or error, the pipeline ran with reduced quality (e.g. 2 of 4 stages instead
    // of 4 of 4). In that case we suppress the user-facing email entirely and
    // only notify the admin address with a ⚠️ prefix, so users never receive
    // degraded picks as if they were normal.
    const councilLogMeta = councilLog as Record<string, unknown>;
    const degradedRun = councilLogMeta?.degradedRun === true;
    const skippedStages = Array.isArray(councilLogMeta?.skippedStages)
      ? (councilLogMeta.skippedStages as unknown[])
      : [];

    if (degradedRun) {
      console.warn(
        `[Analyzer] DEGRADED RUN detected (${skippedStages.length} stage(s) skipped): ` +
          JSON.stringify(skippedStages) +
          ' — suppressing user email, notifying admin only.'
      );
    } else {
      console.log('[Analyzer] Sending email summary...');
    }

    // Try to send the rich HTML email from the Python renderer first
    let emailSent = false;
    try {
      const httpMod = await import('http');
      const emailResponse = await new Promise<Response>((resolve, reject) => {
        const url = new URL(`${COUNCIL_API_URL}/render-email`);
        const req = httpMod.request(
          {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            timeout: 120_000, // 2 minute timeout for email rendering
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
              const body = Buffer.concat(chunks).toString();
              resolve(new Response(body, {
                status: res.statusCode || 500,
                headers: res.headers as Record<string, string>,
              }));
            });
            res.on('error', reject);
          },
        );
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Email render timed out after 2 minutes'));
        });
        req.on('error', reject);
        req.end();
      });
      if (emailResponse.ok) {
        const html = await emailResponse.text();

        if (degradedRun) {
          // Admin-only email with degraded prefix. Users get nothing today.
          const adminAddress = process.env.EMAIL_TO || 'steve@boomerang.energy';
          const degradedHtml =
            `<div style="background:#fff3cd;border:1px solid #ffb800;padding:12px;margin-bottom:16px;border-radius:8px;">` +
            `<strong>⚠️ DEGRADED RUN — DO NOT DISTRIBUTE</strong><br/>` +
            `${skippedStages.length} of 4 council stages were skipped due to timeout or error. ` +
            `Picks shown below were generated with reduced quality. ` +
            `Skipped: ${JSON.stringify(skippedStages)}` +
            `</div>` + html;
          await sendCouncilEmail({
            to: adminAddress,
            date: reportData.date,
            html: degradedHtml,
            topTicker: `⚠️ DEGRADED: ${spikes[0]?.ticker || 'N/A'}`,
            topScore: spikes[0]?.spikeScore || 0,
          });
          console.warn(`[Analyzer] Degraded-run admin notification sent to ${adminAddress}`);
        } else {
          // Normal user-facing email loop
          const councilRecipients = await prisma.user.findMany({
            where: { emailDailySpikes: true },
            select: { email: true },
          });
          for (const recipient of councilRecipients) {
            await sendCouncilEmail({
              to: recipient.email,
              date: reportData.date,
              html,
              topTicker: spikes[0]?.ticker || 'N/A',
              topScore: spikes[0]?.spikeScore || 0,
            });
          }
        }
        emailSent = true;
      }
    } catch (emailErr) {
      console.error('[Analyzer] Rich email failed, falling back to simple:', emailErr);
    }

    // Fallback: send simple daily summary
    // Degraded-run gate applies here too — suppress user emails and notify admin only.
    if (!emailSent) {
      if (degradedRun) {
        const adminAddress = process.env.EMAIL_TO || 'steve@boomerang.energy';
        await sendDailySummary({
          to: adminAddress,
          date: today,
          topSpikes: spikes.map((s) => ({
            rank: s.rank,
            ticker: `⚠️ DEGRADED: ${s.ticker}`,
            name: s.name,
            spikeScore: s.spikeScore,
            predicted3Day: s.predicted3Day,
            predicted5Day: s.predicted5Day,
            predicted8Day: s.predicted8Day,
            narrative: `[DEGRADED RUN — ${skippedStages.length} stages skipped] ${s.narrative || ''}`,
          })),
          marketRegime: reportData.marketRegime,
          tsxLevel: reportData.tsxLevel,
          tsxChange: reportData.tsxChange,
        });
        console.warn(`[Analyzer] Degraded-run fallback admin notification sent to ${adminAddress}`);
      } else {
        // Normal fallback: send simple daily summary to all opted-in users
        const summaryRecipients = await prisma.user.findMany({
          where: { emailDailySpikes: true },
          select: { email: true },
        });
        for (const recipient of summaryRecipients) {
          await sendDailySummary({
            to: recipient.email,
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
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Analyzer] ====== Analysis complete in ${elapsed}s. ${spikes.length} spikes generated. ======\n`);

    return { success: true, spikesGenerated: spikes.length };
  } catch (error) {
    console.error('[Analyzer] Fatal error:', error);
    return { success: false, spikesGenerated: 0, error: String(error) };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// v6.1.0 Phase 1 — Evening Scan
// Runs the full 4-stage council on clean end-of-day data and writes the
// results into the EveningScanArchive (immutable snapshot) + DailyReport +
// Spike tables tagged with scanType='EVENING'.
//
// Does NOT send email in Phase 1. Email path ships in Phase 2.
// ═══════════════════════════════════════════════════════════════════════════

export async function runEveningScan(): Promise<{
  success: boolean;
  picksGenerated: number;
  archiveId?: string;
  deliveredReportId?: string;
  scanDate?: string;
  error?: string;
}> {
  const startTime = Date.now();

  // The evening scan generates picks FOR tomorrow's trading day. Compute
  // tomorrow's date in America/Halifax timezone (matching the morning cron's
  // existing convention).
  const todayHalifax = new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/Halifax',
  });
  const [year, month, day] = todayHalifax.split('-').map(Number);
  const tomorrow = new Date(year, month - 1, day + 1); // local-time arithmetic OK for date math
  const tomorrowStr = tomorrow.toLocaleDateString('en-CA');

  console.log(
    `[EveningScan] ====== Starting evening scan for trading day ${tomorrowStr} ======`
  );

  try {
    // ── Step 1: Call the Python Council Brain via FastAPI ──
    // Uses the same /run-council-mapped endpoint that runDailyAnalysis uses.
    // Same 4-stage council pipeline. Same output shape.
    console.log('[EveningScan] Calling Python Council Brain...');
    const http = await import('http');
    const councilResponse: Response = await new Promise<Response>((resolve, reject) => {
      const url = new URL(`${COUNCIL_API_URL}/run-council-mapped?trigger=evening`);
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          timeout: 3_600_000, // 1 hour socket timeout
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString();
            resolve(
              new Response(body, {
                status: res.statusCode || 500,
                headers: res.headers as Record<string, string>,
              })
            );
          });
          res.on('error', reject);
        }
      );
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Council request timed out after 1 hour'));
      });
      req.on('error', reject);
      req.write(JSON.stringify({}));
      req.end();
    });

    if (!councilResponse.ok) {
      const errText = await councilResponse.text();
      throw new Error(`Council API returned ${councilResponse.status}: ${errText}`);
    }

    const mapped: CouncilMappedResponse = await councilResponse.json();
    const { dailyReport: reportData, spikes, councilLog } = mapped;

    console.log(
      `[EveningScan] Council returned ${spikes.length} picks. Regime: ${reportData.marketRegime}`
    );

    // ── Step 2: Write the EveningScanArchive row FIRST ──
    // Critical invariant: archive write happens BEFORE operational writes.
    // If operational writes fail later, we still have the immutable record.
    // If the archive write fails, the whole scan aborts (no operational state
    // exists without a corresponding archive entry).
    console.log('[EveningScan] Writing EveningScanArchive row...');
    const archiveScanDate = new Date(tomorrow);
    const scanGeneratedAt = new Date();

    // The council output's "regime" is in the rawCouncilOutput; the mapped
    // marketRegime field is the prisma-friendly translation. Use the original
    // RAW regime for the archive so it's auditable.
    const rawCouncil = mapped.rawCouncilOutput as Record<string, unknown>;
    const rawRegime =
      (rawCouncil?.regime as string | undefined) ||
      reportData.marketRegime ||
      'NEUTRAL';

    const archiveRow = await prisma.eveningScanArchive.create({
      data: {
        scanDate: archiveScanDate,
        scanGeneratedAt,
        runId: ((rawCouncil?.run_id as string) || 'unknown'),
        regime: rawRegime,
        macroContextJson: ((rawCouncil?.macro_context as object) || {}),
        universeSize: ((rawCouncil?.universe_size as number) || 0),
        tickersScreened: ((rawCouncil?.tickers_screened as number) || 0),
        skippedStagesJson: ((rawCouncil?.skipped_stages as object) || []),
        topPicksJson: spikes as unknown as object,
        councilLogJson: councilLog as object,
        riskSummaryJson: (mapped.riskSummary || {}) as object,
        dailyRoadmapJson: (mapped.dailyRoadmap || {}) as object,
        rawCouncilOutputJson: mapped.rawCouncilOutput
          ? (mapped.rawCouncilOutput as object)
          : Prisma.JsonNull,
      },
    });
    console.log(`[EveningScan] Archive row created: ${archiveRow.id}`);

    // ── Step 3: Write the operational DailyReport + Spike rows ──
    // These are what the user-facing /api/spikes?scanType=EVENING will return.
    // Use upsert to handle re-runs cleanly (delete existing PortfolioEntry refs,
    // then existing Spike rows, then upsert the report with fresh spikes).
    console.log('[EveningScan] Writing operational DailyReport + Spike rows...');

    const existingReport = await prisma.dailyReport.findUnique({
      where: { date_scanType: { date: archiveScanDate, scanType: 'EVENING' } },
      select: { id: true },
    });

    if (existingReport) {
      console.log(
        `[EveningScan] Existing EVENING report for ${tomorrowStr} found, replacing spikes...`
      );
      await prisma.portfolioEntry.deleteMany({
        where: { spike: { reportId: existingReport.id } },
      });
      await prisma.spike.deleteMany({
        where: { reportId: existingReport.id },
      });
    }

    const reportFields = {
      scanType: 'EVENING' as const,
      marketRegime: reportData.marketRegime,
      tsxLevel: reportData.tsxLevel,
      tsxChange: reportData.tsxChange,
      oilPrice: reportData.oilPrice,
      goldPrice: reportData.goldPrice,
      btcPrice: reportData.btcPrice,
      cadUsd: reportData.cadUsd,
      councilLog: reportData.councilLog as any,
    };

    const spikeData = spikes.map((spike) => ({
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
      convictionScore: spike.convictionScore,
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
      institutionalConvictionScore: spike.institutionalConvictionScore,
      historicalConfidence: spike.historicalConfidence,
      calibrationSamples: spike.calibrationSamples,
      overconfidenceFlag: spike.overconfidenceFlag,
      learningAdjustments: spike.learningAdjustments,
      // v6.1.0 Phase 1 audit fields
      scanType: 'EVENING' as const,
      scanGeneratedAt,
      scanReferencePrice: spike.price,
    }));

    const report = await prisma.dailyReport.upsert({
      where: { date_scanType: { date: archiveScanDate, scanType: 'EVENING' } },
      create: {
        date: archiveScanDate,
        ...reportFields,
        spikes: { create: spikeData },
      },
      update: {
        ...reportFields,
        spikes: { create: spikeData },
      },
    });

    // ── Step 4: Save CouncilLog (existing pattern, evening tag implicit via
    // the report relation) ──
    console.log('[EveningScan] Saving council log...');
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

    // ── Step 5: Link the archive row to the delivered operational report ──
    console.log('[EveningScan] Linking archive to delivered report...');
    await prisma.eveningScanArchive.update({
      where: { id: archiveRow.id },
      data: {
        deliveredReportId: report.id,
        deliveredAt: new Date(),
      },
    });

    // ── Step 6: Send evening preview email to opted-in users ──
    try {
      const eveningRecipients = await prisma.user.findMany({
        where: { emailEveningPreview: true },
        select: { email: true },
      });

      if (eveningRecipients.length > 0) {
        // Render council HTML via Python endpoint
        const httpMod = await import('http');
        const emailResponse = await new Promise<Response>((resolve, reject) => {
          const url = new URL(`${COUNCIL_API_URL}/render-email`);
          const req = httpMod.request(
            {
              hostname: url.hostname,
              port: url.port,
              path: url.pathname,
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              timeout: 120_000,
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on('data', (chunk: Buffer) => chunks.push(chunk));
              res.on('end', () => {
                const body = Buffer.concat(chunks).toString();
                resolve(new Response(body, {
                  status: res.statusCode || 500,
                  headers: res.headers as Record<string, string>,
                }));
              });
              res.on('error', reject);
            },
          );
          req.on('timeout', () => { req.destroy(); reject(new Error('Email render timed out')); });
          req.on('error', reject);
          req.end();
        });

        if (emailResponse.ok) {
          const html = await emailResponse.text();
          for (const recipient of eveningRecipients) {
            await sendEveningPreviewEmail({
              to: recipient.email,
              date: tomorrowStr,
              html,
              topTicker: spikes[0]?.ticker || 'N/A',
              topScore: spikes[0]?.spikeScore || 0,
            });
          }
          console.log(`[EveningScan] Evening preview email sent to ${eveningRecipients.length} user(s)`);
        } else {
          console.warn('[EveningScan] Email render failed — skipping evening email');
        }
      } else {
        console.log('[EveningScan] No users opted in to evening preview email');
      }
    } catch (emailErr) {
      console.error('[EveningScan] Evening email failed (non-fatal):', emailErr);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `[EveningScan] ====== Evening scan complete in ${elapsed}s. ${spikes.length} picks generated for ${tomorrowStr}. ======\n`
    );

    return {
      success: true,
      picksGenerated: spikes.length,
      archiveId: archiveRow.id,
      deliveredReportId: report.id,
      scanDate: tomorrowStr,
    };
  } catch (error) {
    console.error('[EveningScan] Fatal error:', error);
    return {
      success: false,
      picksGenerated: 0,
      error: String(error),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// v6.1.0 Phase 2 — Morning Scan
// Runs the full 4-stage council on pre-market data and writes the results
// into the MorningScanArchive (immutable snapshot) + DailyReport + Spike
// tables tagged with scanType='MORNING'.
//
// Sends standard morning email via sendCouncilEmail() to opted-in users.
// Degraded-run gate suppresses user emails (admin-only notification).
// ═══════════════════════════════════════════════════════════════════════════

export async function runMorningScan(useCached = false): Promise<{
  success: boolean;
  picksGenerated: number;
  archiveId?: string;
  deliveredReportId?: string;
  scanDate?: string;
  error?: string;
}> {
  const startTime = Date.now();

  // The morning scan generates picks FOR today's trading day.
  // Compute today's date in America/Halifax timezone.
  const now = new Date();
  const halifaxDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/Halifax' }));
  const todayStr = halifaxDate.toISOString().split('T')[0];
  const today = new Date(todayStr + 'T12:00:00Z'); // the trading day the picks are FOR (= today)

  console.log(
    `[MorningScan] ====== Starting morning scan for trading day ${todayStr} ======`
  );

  try {
    // ── Step 1: Call the Python Council Brain via FastAPI ──
    // Uses /run-council-mapped for live runs, /latest-output-mapped for cached.
    // Same 4-stage council pipeline. Same output shape.
    const http = await import('http');
    let councilResponse: Response;

    if (useCached) {
      console.log('[MorningScan] Using cached council output...');
      councilResponse = await new Promise<Response>((resolve, reject) => {
        const url = new URL(`${COUNCIL_API_URL}/latest-output-mapped`);
        const req = http.request(
          {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'GET',
            timeout: 60_000, // 1 minute timeout for cached data
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
              const body = Buffer.concat(chunks).toString();
              resolve(new Response(body, {
                status: res.statusCode || 500,
                headers: res.headers as Record<string, string>,
              }));
            });
            res.on('error', reject);
          },
        );
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Cached council fetch timed out after 1 minute'));
        });
        req.on('error', reject);
        req.end();
      });
    } else {
      console.log('[MorningScan] Calling Python Council Brain...');
      councilResponse = await new Promise<Response>((resolve, reject) => {
        const url = new URL(`${COUNCIL_API_URL}/run-council-mapped?trigger=morning`);
        const req = http.request(
          {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            timeout: 3_600_000, // 1 hour socket timeout
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
              const body = Buffer.concat(chunks).toString();
              resolve(
                new Response(body, {
                  status: res.statusCode || 500,
                  headers: res.headers as Record<string, string>,
                })
              );
            });
            res.on('error', reject);
          }
        );
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Council request timed out after 1 hour'));
        });
        req.on('error', reject);
        req.write(JSON.stringify({}));
        req.end();
      });
    }

    if (!councilResponse.ok) {
      const errText = await councilResponse.text();
      throw new Error(`Council API returned ${councilResponse.status}: ${errText}`);
    }

    const mapped: CouncilMappedResponse = await councilResponse.json();
    const { dailyReport: reportData, spikes, councilLog } = mapped;

    console.log(
      `[MorningScan] Council returned ${spikes.length} picks. Regime: ${reportData.marketRegime}`
    );

    // ── Step 2: Write the MorningScanArchive row FIRST ──
    // Critical invariant: archive write happens BEFORE operational writes.
    // If operational writes fail later, we still have the immutable record.
    // If the archive write fails, the whole scan aborts (no operational state
    // exists without a corresponding archive entry).
    console.log('[MorningScan] Writing MorningScanArchive row...');
    const archiveScanDate = new Date(today); // the trading day the picks are FOR (= today)
    const scanGeneratedAt = new Date();

    // The council output's "regime" is in the rawCouncilOutput; the mapped
    // marketRegime field is the prisma-friendly translation. Use the original
    // RAW regime for the archive so it's auditable.
    const rawCouncil = mapped.rawCouncilOutput as Record<string, unknown>;
    const rawRegime =
      (rawCouncil?.regime as string | undefined) ||
      reportData.marketRegime ||
      'NEUTRAL';

    const archiveRow = await prisma.morningScanArchive.create({
      data: {
        scanDate: archiveScanDate,
        scanGeneratedAt,
        runId: ((rawCouncil?.run_id as string) || 'unknown'),
        regime: rawRegime,
        macroContextJson: ((rawCouncil?.macro_context as object) || {}),
        universeSize: ((rawCouncil?.universe_size as number) || 0),
        tickersScreened: ((rawCouncil?.tickers_screened as number) || 0),
        skippedStagesJson: ((rawCouncil?.skipped_stages as object) || []),
        topPicksJson: spikes as unknown as object,
        councilLogJson: councilLog as object,
        riskSummaryJson: (mapped.riskSummary || {}) as object,
        dailyRoadmapJson: (mapped.dailyRoadmap || {}) as object,
        rawCouncilOutputJson: mapped.rawCouncilOutput
          ? (mapped.rawCouncilOutput as object)
          : Prisma.JsonNull,
      },
    });
    console.log(`[MorningScan] Archive row created: ${archiveRow.id}`);

    // ── Step 3: Write the operational DailyReport + Spike rows ──
    // These are what the user-facing /api/spikes?scanType=MORNING will return.
    // Use upsert to handle re-runs cleanly (delete existing PortfolioEntry refs,
    // then existing Spike rows, then upsert the report with fresh spikes).
    console.log('[MorningScan] Writing operational DailyReport + Spike rows...');

    const existingReport = await prisma.dailyReport.findUnique({
      where: { date_scanType: { date: archiveScanDate, scanType: 'MORNING' } },
      select: { id: true },
    });

    if (existingReport) {
      console.log(
        `[MorningScan] Existing MORNING report for ${todayStr} found, replacing spikes...`
      );
      await prisma.portfolioEntry.deleteMany({
        where: { spike: { reportId: existingReport.id } },
      });
      await prisma.spike.deleteMany({
        where: { reportId: existingReport.id },
      });
    }

    const reportFields = {
      scanType: 'MORNING' as const,
      marketRegime: reportData.marketRegime,
      tsxLevel: reportData.tsxLevel,
      tsxChange: reportData.tsxChange,
      oilPrice: reportData.oilPrice,
      goldPrice: reportData.goldPrice,
      btcPrice: reportData.btcPrice,
      cadUsd: reportData.cadUsd,
      councilLog: reportData.councilLog as any,
    };

    const spikeData = spikes.map((spike) => ({
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
      convictionScore: spike.convictionScore,
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
      institutionalConvictionScore: spike.institutionalConvictionScore,
      historicalConfidence: spike.historicalConfidence,
      calibrationSamples: spike.calibrationSamples,
      overconfidenceFlag: spike.overconfidenceFlag,
      learningAdjustments: spike.learningAdjustments,
      // v6.1.0 Phase 2 audit fields
      scanType: 'MORNING' as const,
      scanGeneratedAt,
      scanReferencePrice: spike.price,
    }));

    const report = await prisma.dailyReport.upsert({
      where: { date_scanType: { date: archiveScanDate, scanType: 'MORNING' } },
      create: {
        date: archiveScanDate,
        ...reportFields,
        spikes: { create: spikeData },
      },
      update: {
        ...reportFields,
        spikes: { create: spikeData },
      },
    });

    // ── Step 4: Save CouncilLog (existing pattern) ──
    console.log('[MorningScan] Saving council log...');
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

    // ── Step 5: Link the archive row to the delivered operational report ──
    console.log('[MorningScan] Linking archive to delivered report...');
    await prisma.morningScanArchive.update({
      where: { id: archiveRow.id },
      data: {
        deliveredReportId: report.id,
        deliveredAt: new Date(),
      },
    });

    // ── Step 6: Send morning email to opted-in users ──
    // Degraded-run gate: if any LLM stage was skipped due to timeout or error,
    // suppress user-facing email and only notify admin.
    const councilLogMeta = councilLog as Record<string, unknown>;
    const degradedRun = councilLogMeta?.degradedRun === true;
    const skippedStages = Array.isArray(councilLogMeta?.skippedStages)
      ? (councilLogMeta.skippedStages as unknown[])
      : [];

    if (degradedRun) {
      console.warn(
        `[MorningScan] DEGRADED RUN detected (${skippedStages.length} stage(s) skipped): ` +
          JSON.stringify(skippedStages) +
          ' — suppressing user email, notifying admin only.'
      );
    } else {
      console.log('[MorningScan] Sending email summary...');
    }

    // Try to send the rich HTML email from the Python renderer first
    let emailSent = false;
    try {
      const httpMod = await import('http');
      const emailResponse = await new Promise<Response>((resolve, reject) => {
        const url = new URL(`${COUNCIL_API_URL}/render-email`);
        const req = httpMod.request(
          {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            timeout: 120_000, // 2 minute timeout for email rendering
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
              const body = Buffer.concat(chunks).toString();
              resolve(new Response(body, {
                status: res.statusCode || 500,
                headers: res.headers as Record<string, string>,
              }));
            });
            res.on('error', reject);
          },
        );
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Email render timed out after 2 minutes'));
        });
        req.on('error', reject);
        req.end();
      });
      if (emailResponse.ok) {
        const html = await emailResponse.text();

        if (degradedRun) {
          // Admin-only email with degraded prefix. Users get nothing today.
          const adminAddress = process.env.EMAIL_TO || 'steve@boomerang.energy';
          const degradedHtml =
            `<div style="background:#fff3cd;border:1px solid #ffb800;padding:12px;margin-bottom:16px;border-radius:8px;">` +
            `<strong>⚠️ DEGRADED RUN — DO NOT DISTRIBUTE</strong><br/>` +
            `${skippedStages.length} of 4 council stages were skipped due to timeout or error. ` +
            `Picks shown below were generated with reduced quality. ` +
            `Skipped: ${JSON.stringify(skippedStages)}` +
            `</div>` + html;
          await sendCouncilEmail({
            to: adminAddress,
            date: reportData.date,
            html: degradedHtml,
            topTicker: `⚠️ DEGRADED: ${spikes[0]?.ticker || 'N/A'}`,
            topScore: spikes[0]?.spikeScore || 0,
          });
          console.warn(`[MorningScan] Degraded-run admin notification sent to ${adminAddress}`);
        } else {
          // Normal user-facing email loop
          const councilRecipients = await prisma.user.findMany({
            where: { emailDailySpikes: true },
            select: { email: true },
          });
          for (const recipient of councilRecipients) {
            await sendCouncilEmail({
              to: recipient.email,
              date: reportData.date,
              html,
              topTicker: spikes[0]?.ticker || 'N/A',
              topScore: spikes[0]?.spikeScore || 0,
            });
          }
        }
        emailSent = true;
      }
    } catch (emailErr) {
      console.error('[MorningScan] Rich email failed, falling back to simple:', emailErr);
    }

    // Fallback: send simple daily summary
    // Degraded-run gate applies here too — suppress user emails and notify admin only.
    if (!emailSent) {
      if (degradedRun) {
        const adminAddress = process.env.EMAIL_TO || 'steve@boomerang.energy';
        await sendDailySummary({
          to: adminAddress,
          date: todayStr,
          topSpikes: spikes.map((s) => ({
            rank: s.rank,
            ticker: `⚠️ DEGRADED: ${s.ticker}`,
            name: s.name,
            spikeScore: s.spikeScore,
            predicted3Day: s.predicted3Day,
            predicted5Day: s.predicted5Day,
            predicted8Day: s.predicted8Day,
            narrative: `[DEGRADED RUN — ${skippedStages.length} stages skipped] ${s.narrative || ''}`,
          })),
          marketRegime: reportData.marketRegime,
          tsxLevel: reportData.tsxLevel,
          tsxChange: reportData.tsxChange,
        });
        console.warn(`[MorningScan] Degraded-run fallback admin notification sent to ${adminAddress}`);
      } else {
        // Normal fallback: send simple daily summary to all opted-in users
        const summaryRecipients = await prisma.user.findMany({
          where: { emailDailySpikes: true },
          select: { email: true },
        });
        for (const recipient of summaryRecipients) {
          await sendDailySummary({
            to: recipient.email,
            date: todayStr,
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
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `[MorningScan] ====== Morning scan complete in ${elapsed}s. ${spikes.length} picks generated for ${todayStr}. ======\n`
    );

    return {
      success: true,
      picksGenerated: spikes.length,
      archiveId: archiveRow.id,
      deliveredReportId: report.id,
      scanDate: todayStr,
    };
  } catch (error) {
    console.error('[MorningScan] Fatal error:', error);
    return {
      success: false,
      picksGenerated: 0,
      error: String(error),
    };
  }
}
