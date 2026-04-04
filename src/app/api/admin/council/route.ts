import { NextResponse } from 'next/server';
import { runDailyAnalysis } from '@/lib/scheduling/analyzer';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const COUNCIL_API_URL = process.env.COUNCIL_API_URL || 'http://localhost:8100';

// Track in-memory run state (within this Next.js process)
let _runInProgress = false;
let _lastTriggerResult: { success: boolean; error?: string; startedAt?: string; completedAt?: string; spikeCount?: number } | null = null;

// Allow up to 1 hour for the council pipeline
export const maxDuration = 3600;

// Safe fetch helper — returns null on failure instead of throwing
async function safeFetch<T>(url: string, timeoutMs: number): Promise<T | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      next: { revalidate: 0 },
    });
    if (res.ok) return await res.json() as T;
    return null;
  } catch {
    return null;
  }
}

// GET /api/admin/council — Get council status + recent runs
export async function GET() {
  try {
    // Fire ALL Python fetches + Prisma queries in parallel (no sequential blocking)
    const [
      councilHealthResult,
      fmpHealthResult,
      runStatusResult,
      latestOutputResult,
      openingBellStatusResult,
      openingBellHealthResult,
      radarStatusResult,
      radarHealthResult,
      recentReports,
      latestLog,
    ] = await Promise.all([
      // Python health — retry once on failure (most critical endpoint)
      safeFetch<Record<string, unknown>>(`${COUNCIL_API_URL}/health`, 8000)
        .then(async (r) => r ?? (await new Promise(res => setTimeout(res, 1500)).then(() =>
          safeFetch<Record<string, unknown>>(`${COUNCIL_API_URL}/health`, 8000)
        ))),
      // FMP health — non-critical, short timeout
      safeFetch<Record<string, unknown>>(`${COUNCIL_API_URL}/fmp-health`, 5000),
      // Run status — critical during active runs, short timeout
      safeFetch<Record<string, unknown>>(`${COUNCIL_API_URL}/run-status`, 5000),
      // Latest output — non-critical, short timeout
      safeFetch<Record<string, unknown>>(`${COUNCIL_API_URL}/latest-output`, 5000),
      // Opening Bell run status — non-critical, short timeout
      safeFetch<Record<string, unknown>>(`${COUNCIL_API_URL}/run-opening-bell-status`, 5000),
      // Opening Bell FMP health — non-critical, short timeout
      safeFetch<Record<string, unknown>>(`${COUNCIL_API_URL}/opening-bell-health`, 5000),
      // Radar run status — non-critical, short timeout
      safeFetch<Record<string, unknown>>(`${COUNCIL_API_URL}/run-radar-status`, 5000),
      // Radar FMP health — non-critical, short timeout
      safeFetch<Record<string, unknown>>(`${COUNCIL_API_URL}/radar-health`, 5000),
      // Prisma: recent reports
      prisma.dailyReport.findMany({
        take: 5,
        orderBy: { date: 'desc' },
        select: {
          id: true,
          date: true,
          generatedAt: true,
          marketRegime: true,
          _count: { select: { spikes: true } },
        },
      }),
      // Prisma: latest council log
      prisma.councilLog.findFirst({
        orderBy: { date: 'desc' },
        select: { processingTime: true, consensusScore: true, date: true },
      }),
    ]);

    const councilHealth = councilHealthResult ?? { status: 'unreachable', council_running: false };
    const fmpHealth = fmpHealthResult?.success ? fmpHealthResult : null;
    const latestStageMetadata = latestOutputResult?.stage_metadata ?? null;
    const openingBellStatus = openingBellStatusResult ?? null;
    const openingBellHealth = openingBellHealthResult ?? null;
    const radarStatus = radarStatusResult ?? null;
    const radarHealth = radarHealthResult ?? null;

    return NextResponse.json({
      success: true,
      data: {
        councilHealth,
        runInProgress: _runInProgress || (councilHealth.council_running === true),
        lastTriggerResult: _lastTriggerResult,
        latestLog: latestLog ? {
          date: latestLog.date,
          processingTimeMs: latestLog.processingTime,
          consensusScore: latestLog.consensusScore,
        } : null,
        fmpHealth,
        runStatus: runStatusResult,
        latestStageMetadata,
        openingBellStatus,
        openingBellHealth,
        radarStatus,
        radarHealth: radarHealth ? { endpoints: radarHealth } : null,
        recentReports: recentReports.map((r) => ({
          id: r.id,
          date: r.date,
          generatedAt: r.generatedAt,
          regime: r.marketRegime,
          spikeCount: r._count.spikes,
        })),
      },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}

// POST /api/admin/council — Trigger a council or opening-bell run (background)
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));

  // Route to Radar trigger
  if (body.type === 'radar') {
    try {
      const res = await fetch(`${COUNCIL_API_URL}/run-radar`, {
        method: 'POST',
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => 'unknown error');
        return NextResponse.json(
          { success: false, error: `Radar trigger failed: ${errText}` },
          { status: res.status }
        );
      }
      return NextResponse.json({
        success: true,
        message: 'Radar run started. Poll GET /api/admin/council for status.',
      });
    } catch (error) {
      return NextResponse.json(
        { success: false, error: `Failed to reach Python server: ${String(error)}` },
        { status: 503 }
      );
    }
  }

  // Route to Opening Bell trigger
  if (body.type === 'opening-bell') {
    try {
      const res = await fetch(`${COUNCIL_API_URL}/run-opening-bell`, {
        method: 'POST',
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => 'unknown error');
        return NextResponse.json(
          { success: false, error: `Opening Bell trigger failed: ${errText}` },
          { status: res.status }
        );
      }
      return NextResponse.json({
        success: true,
        message: 'Opening Bell run started. Poll GET /api/admin/council for status.',
      });
    } catch (error) {
      return NextResponse.json(
        { success: false, error: `Failed to reach Python server: ${String(error)}` },
        { status: 503 }
      );
    }
  }

  // Default: Council run
  if (_runInProgress) {
    return NextResponse.json(
      { success: false, error: 'A council run is already in progress' },
      { status: 409 }
    );
  }

  // Check Python-side too
  try {
    const healthRes = await fetch(`${COUNCIL_API_URL}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    const health = await healthRes.json();
    if (health.council_running) {
      return NextResponse.json(
        { success: false, error: 'Council is already running on the Python server' },
        { status: 409 }
      );
    }
  } catch {
    // If we can't reach the Python server, let the run attempt handle the error
  }

  _runInProgress = true;
  _lastTriggerResult = { success: false, startedAt: new Date().toISOString() };

  // Fire and forget — run in background
  runDailyAnalysis(false, 'manual')
    .then((result) => {
      _lastTriggerResult = {
        success: true,
        startedAt: _lastTriggerResult?.startedAt,
        completedAt: new Date().toISOString(),
        spikeCount: result.spikesGenerated ?? 0,
      };
    })
    .catch((error) => {
      _lastTriggerResult = {
        success: false,
        startedAt: _lastTriggerResult?.startedAt,
        completedAt: new Date().toISOString(),
        error: String(error),
      };
    })
    .finally(() => {
      _runInProgress = false;
    });

  return NextResponse.json({
    success: true,
    message: 'Council run started in background. Poll GET /api/admin/council for status.',
  });
}
