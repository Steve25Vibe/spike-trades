// ============================================
// SCAN PIPELINE — v6.1.2 Amalgamated Helpers
// Morning scan runs at 11:15am AST, evening scan at 8:00pm AST
// Calls Python Council Brain via FastAPI, then saves results to Prisma
// ============================================

import { Prisma } from '@prisma/client';
import prisma from '@/lib/db/prisma';
import { sendDailySummary, sendCouncilEmail, sendEveningPreviewEmail } from '@/lib/email/resend';

const COUNCIL_API_URL = process.env.COUNCIL_API_URL || 'http://localhost:8100';

type ScanType = 'MORNING' | 'EVENING';

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
    // Hit Rate 2.0 fields
    setupRateCILow?: number | null;
    setupRateCIHigh?: number | null;
    tickerRate?: number | null;
    tickerRateSamples?: number | null;
    tickerRateCILow?: number | null;
    tickerRateCIHigh?: number | null;
    tickerMedianMoveOnHits?: number | null;
    tickerMedianMoveOnMisses?: number | null;
    setupRateRegime?: string | null;
    setupMedianMoveOnHits?: number | null;
    setupMedianMoveOnMisses?: number | null;
    calibrationReconciliation?: string | null;
  }[];
  councilLog: Record<string, unknown>;
  riskSummary: Record<string, unknown>;
  dailyRoadmap: Record<string, unknown>;
  rawCouncilOutput: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Helper 1: callCouncilBrain — unified council HTTP call
// ═══════════════════════════════════════════════════════════════════════════

async function callCouncilBrain(opts: {
  trigger: 'morning' | 'evening';
  cached?: boolean;
}): Promise<CouncilMappedResponse> {
  const http = await import('http');
  let councilResponse: Response;

  if (opts.cached) {
    console.log(`[Analyzer] Using cached council output...`);
    councilResponse = await new Promise<Response>((resolve, reject) => {
      const url = new URL(`${COUNCIL_API_URL}/latest-output-mapped`);
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'GET',
          timeout: 60_000,
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
    console.log(`[Analyzer] Calling Python Council Brain (trigger=${opts.trigger})...`);
    councilResponse = await new Promise<Response>((resolve, reject) => {
      const url = new URL(`${COUNCIL_API_URL}/run-council-mapped?trigger=${opts.trigger}`);
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          timeout: 3_600_000,
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

  return councilResponse.json();
}

// ═══════════════════════════════════════════════════════════════════════════
// Helper 2: writeScanArchive — write immutable archive row
// ═══════════════════════════════════════════════════════════════════════════

async function writeScanArchive(
  scanType: ScanType,
  data: {
    scanDate: Date;
    scanGeneratedAt: Date;
    mapped: CouncilMappedResponse;
  },
): Promise<string> {
  const { scanDate, scanGeneratedAt, mapped } = data;
  const rawCouncil = mapped.rawCouncilOutput as Record<string, unknown>;
  const rawRegime =
    (rawCouncil?.regime as string | undefined) ||
    mapped.dailyReport.marketRegime ||
    'NEUTRAL';

  const archiveData = {
    scanDate,
    scanGeneratedAt,
    runId: (rawCouncil?.run_id as string) || 'unknown',
    regime: rawRegime,
    macroContextJson: (rawCouncil?.macro_context as object) || {},
    universeSize: (rawCouncil?.universe_size as number) || 0,
    tickersScreened: (rawCouncil?.tickers_screened as number) || 0,
    skippedStagesJson: (rawCouncil?.skipped_stages as object) || [],
    topPicksJson: mapped.spikes as unknown as object,
    councilLogJson: mapped.councilLog as object,
    riskSummaryJson: (mapped.riskSummary || {}) as object,
    dailyRoadmapJson: (mapped.dailyRoadmap || {}) as object,
    rawCouncilOutputJson: mapped.rawCouncilOutput
      ? (mapped.rawCouncilOutput as object)
      : Prisma.JsonNull,
  };

  const label = scanType === 'EVENING' ? 'EveningScan' : 'MorningScan';
  console.log(`[${label}] Writing ${scanType} archive row...`);

  if (scanType === 'EVENING') {
    const row = await prisma.eveningScanArchive.create({ data: archiveData });
    console.log(`[${label}] Archive row created: ${row.id}`);
    return row.id;
  } else {
    const row = await prisma.morningScanArchive.create({ data: archiveData });
    console.log(`[${label}] Archive row created: ${row.id}`);
    return row.id;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Helper 3: buildSpikeData — map council output to Prisma Spike fields
// ═══════════════════════════════════════════════════════════════════════════

function buildSpikeData(
  spikes: CouncilMappedResponse['spikes'],
  scanType: ScanType,
  scanGeneratedAt: Date,
) {
  return spikes.map((spike) => ({
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
    // IIC
    institutionalConvictionScore: spike.institutionalConvictionScore,
    // Calibration
    historicalConfidence: spike.historicalConfidence,
    calibrationSamples: spike.calibrationSamples,
    overconfidenceFlag: spike.overconfidenceFlag,
    // Hit Rate 2.0
    setupRateCILow: spike.setupRateCILow ?? null,
    setupRateCIHigh: spike.setupRateCIHigh ?? null,
    tickerRate: spike.tickerRate ?? null,
    tickerRateSamples: spike.tickerRateSamples ?? null,
    tickerRateCILow: spike.tickerRateCILow ?? null,
    tickerRateCIHigh: spike.tickerRateCIHigh ?? null,
    tickerMedianMoveOnHits: spike.tickerMedianMoveOnHits ?? null,
    tickerMedianMoveOnMisses: spike.tickerMedianMoveOnMisses ?? null,
    setupRateRegime: spike.setupRateRegime ?? null,
    setupMedianMoveOnHits: spike.setupMedianMoveOnHits ?? null,
    setupMedianMoveOnMisses: spike.setupMedianMoveOnMisses ?? null,
    calibrationReconciliation: spike.calibrationReconciliation ?? null,
    // Learning
    learningAdjustments: spike.learningAdjustments,
    // v6.1.0 audit fields
    scanType,
    scanGeneratedAt,
    scanReferencePrice: spike.price,
  }));
}

// ═══════════════════════════════════════════════════════════════════════════
// Helper 4: saveScanReport — upsert DailyReport + Spikes + CouncilLog
// ═══════════════════════════════════════════════════════════════════════════

async function saveScanReport(opts: {
  date: Date;
  scanType: ScanType;
  mapped: CouncilMappedResponse;
  scanGeneratedAt: Date;
}): Promise<{ reportId: string; spikeCount: number }> {
  const { date, scanType, mapped, scanGeneratedAt } = opts;
  const { dailyReport: reportData, spikes, councilLog } = mapped;
  const label = scanType === 'EVENING' ? 'EveningScan' : 'MorningScan';

  console.log(`[${label}] Writing operational DailyReport + Spike rows...`);

  // Check for existing report with same date+scanType
  const existingReport = await prisma.dailyReport.findUnique({
    where: { date_scanType: { date, scanType } },
    select: { id: true },
  });

  // If re-running: delete old PortfolioEntry refs + Spike rows (scoped DELETE)
  if (existingReport) {
    console.log(`[${label}] Existing ${scanType} report found, replacing spikes...`);
    await prisma.portfolioEntry.deleteMany({
      where: { spike: { reportId: existingReport.id } },
    });
    await prisma.spike.deleteMany({
      where: { reportId: existingReport.id },
    });
  }

  const reportFields = {
    scanType,
    marketRegime: reportData.marketRegime,
    tsxLevel: reportData.tsxLevel,
    tsxChange: reportData.tsxChange,
    oilPrice: reportData.oilPrice,
    goldPrice: reportData.goldPrice,
    btcPrice: reportData.btcPrice,
    cadUsd: reportData.cadUsd,
    councilLog: reportData.councilLog as any,
  };

  const spikeData = buildSpikeData(spikes, scanType, scanGeneratedAt);

  const report = await prisma.dailyReport.upsert({
    where: { date_scanType: { date, scanType } },
    create: {
      date,
      ...reportFields,
      spikes: { create: spikeData },
    },
    update: {
      ...reportFields,
      spikes: { create: spikeData },
    },
  });

  // Save CouncilLog with scanType composite key
  console.log(`[${label}] Saving council log...`);
  const reportDate = new Date(reportData.date);
  await prisma.councilLog.upsert({
    where: { date_scanType: { date: reportDate, scanType } },
    create: {
      date: reportDate,
      scanType,
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

  return { reportId: report.id, spikeCount: spikes.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// Helper 5: sendScanEmail — dispatch email based on scan type
// ═══════════════════════════════════════════════════════════════════════════

async function sendScanEmail(
  scanType: ScanType,
  opts: {
    dateStr: string;
    spikes: CouncilMappedResponse['spikes'];
    reportData: CouncilMappedResponse['dailyReport'];
    councilLog: Record<string, unknown>;
  },
): Promise<void> {
  const { dateStr, spikes, reportData, councilLog } = opts;

  if (scanType === 'EVENING') {
    // Evening path: send preview email to opted-in users
    try {
      const eveningRecipients = await prisma.user.findMany({
        where: { emailEveningPreview: true },
        select: { email: true },
      });

      if (eveningRecipients.length > 0) {
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
              date: dateStr,
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
    return;
  }

  // Morning path: degraded-run gate + rich HTML email + fallback
  const degradedRun = councilLog?.degradedRun === true;
  const skippedStages = Array.isArray(councilLog?.skippedStages)
    ? (councilLog.skippedStages as unknown[])
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
  if (!emailSent) {
    if (degradedRun) {
      const adminAddress = process.env.EMAIL_TO || 'steve@boomerang.energy';
      await sendDailySummary({
        to: adminAddress,
        date: dateStr,
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
      const summaryRecipients = await prisma.user.findMany({
        where: { emailDailySpikes: true },
        select: { email: true },
      });
      for (const recipient of summaryRecipients) {
        await sendDailySummary({
          to: recipient.email,
          date: dateStr,
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
}

// ═══════════════════════════════════════════════════════════════════════════
// Evening Scan — thin wrapper
// Runs the full 4-stage council on clean end-of-day data.
// Writes EveningScanArchive + DailyReport + Spikes + CouncilLog.
// Sends evening preview email to opted-in users.
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

  // Evening scan generates picks FOR tomorrow's trading day
  const todayHalifax = new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/Halifax',
  });
  const [year, month, day] = todayHalifax.split('-').map(Number);
  const tomorrow = new Date(year, month - 1, day + 1);
  const tomorrowStr = tomorrow.toLocaleDateString('en-CA');

  console.log(`[EveningScan] ====== Starting evening scan for trading day ${tomorrowStr} ======`);

  try {
    // 1. Call council brain
    const mapped = await callCouncilBrain({ trigger: 'evening' });
    console.log(`[EveningScan] Council returned ${mapped.spikes.length} picks. Regime: ${mapped.dailyReport.marketRegime}`);

    // 2. Write archive (must succeed or scan aborts)
    const scanGeneratedAt = new Date();
    const archiveId = await writeScanArchive('EVENING', {
      scanDate: new Date(tomorrow),
      scanGeneratedAt,
      mapped,
    });

    // 3. Save report + spikes + council log
    const { reportId, spikeCount } = await saveScanReport({
      date: new Date(tomorrow),
      scanType: 'EVENING',
      mapped,
      scanGeneratedAt,
    });

    // 4. Link archive to delivered report
    console.log('[EveningScan] Linking archive to delivered report...');
    await prisma.eveningScanArchive.update({
      where: { id: archiveId },
      data: { deliveredReportId: reportId, deliveredAt: new Date() },
    });

    // 5. Send email
    await sendScanEmail('EVENING', {
      dateStr: tomorrowStr,
      spikes: mapped.spikes,
      reportData: mapped.dailyReport,
      councilLog: mapped.councilLog,
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[EveningScan] ====== Evening scan complete in ${elapsed}s. ${spikeCount} picks generated for ${tomorrowStr}. ======\n`);

    return {
      success: true,
      picksGenerated: spikeCount,
      archiveId,
      deliveredReportId: reportId,
      scanDate: tomorrowStr,
    };
  } catch (error) {
    console.error('[EveningScan] Fatal error:', error);
    return { success: false, picksGenerated: 0, error: String(error) };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Morning Scan — thin wrapper
// Runs the full 4-stage council on pre-market data.
// Writes MorningScanArchive + DailyReport + Spikes + CouncilLog.
// Sends morning email with degraded-run gate.
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

  // Morning scan generates picks FOR today's trading day
  const now = new Date();
  const halifaxDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/Halifax' }));
  const todayStr = halifaxDate.toISOString().split('T')[0];
  const today = new Date(todayStr + 'T12:00:00Z');

  console.log(`[MorningScan] ====== Starting morning scan for trading day ${todayStr} ======`);

  try {
    // 1. Call council brain
    const mapped = await callCouncilBrain({ trigger: 'morning', cached: useCached });
    console.log(`[MorningScan] Council returned ${mapped.spikes.length} picks. Regime: ${mapped.dailyReport.marketRegime}`);

    // 2. Write archive (must succeed or scan aborts)
    const scanGeneratedAt = new Date();
    const archiveId = await writeScanArchive('MORNING', {
      scanDate: new Date(today),
      scanGeneratedAt,
      mapped,
    });

    // 3. Save report + spikes + council log
    const { reportId, spikeCount } = await saveScanReport({
      date: new Date(today),
      scanType: 'MORNING',
      mapped,
      scanGeneratedAt,
    });

    // 4. Link archive to delivered report
    console.log('[MorningScan] Linking archive to delivered report...');
    await prisma.morningScanArchive.update({
      where: { id: archiveId },
      data: { deliveredReportId: reportId, deliveredAt: new Date() },
    });

    // 5. Send email
    await sendScanEmail('MORNING', {
      dateStr: todayStr,
      spikes: mapped.spikes,
      reportData: mapped.dailyReport,
      councilLog: mapped.councilLog,
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[MorningScan] ====== Morning scan complete in ${elapsed}s. ${spikeCount} picks generated for ${todayStr}. ======\n`);

    return {
      success: true,
      picksGenerated: spikeCount,
      archiveId,
      deliveredReportId: reportId,
      scanDate: todayStr,
    };
  } catch (error) {
    console.error('[MorningScan] Fatal error:', error);
    return { success: false, picksGenerated: 0, error: String(error) };
  }
}
