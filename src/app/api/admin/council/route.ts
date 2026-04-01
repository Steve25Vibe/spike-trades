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

// GET /api/admin/council — Get council status + recent runs
export async function GET() {
  try {
    // Fetch Python council health (with retry — council can be slow under LLM load)
    let councilHealth: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const healthRes = await fetch(`${COUNCIL_API_URL}/health`, {
          signal: AbortSignal.timeout(15000),
        });
        councilHealth = await healthRes.json();
        break; // Success — stop retrying
      } catch {
        if (attempt === 0) {
          await new Promise(r => setTimeout(r, 2000)); // Wait 2s before retry
        } else {
          councilHealth = { status: 'unreachable', council_running: false };
        }
      }
    }

    // Fetch recent daily reports from Prisma
    const recentReports = await prisma.dailyReport.findMany({
      take: 5,
      orderBy: { date: 'desc' },
      select: {
        id: true,
        date: true,
        generatedAt: true,
        marketRegime: true,
        _count: { select: { spikes: true } },
      },
    });

    // Fetch latest council log for processing time
    const latestLog = await prisma.councilLog.findFirst({
      orderBy: { date: 'desc' },
      select: { processingTime: true, consensusScore: true, date: true },
    });

    // Fetch FMP endpoint health from council
    let fmpHealth: Record<string, unknown> | null = null;
    try {
      const fmpRes = await fetch(`${COUNCIL_API_URL}/fmp-health`, {
        signal: AbortSignal.timeout(10000),
      });
      const fmpJson = await fmpRes.json();
      if (fmpJson.success) fmpHealth = fmpJson;
    } catch {
      // Council unreachable — fmpHealth stays null
    }

    // Fetch run-status from Python council
    let runStatus = null;
    try {
      const statusRes = await fetch(`${COUNCIL_API_URL}/run-status`, { next: { revalidate: 0 } });
      if (statusRes.ok) runStatus = await statusRes.json();
    } catch {}

    // Fetch stage_metadata (token usage) from latest council output
    let latestStageMetadata: Record<string, unknown> | null = null;
    try {
      const outputRes = await fetch(`${COUNCIL_API_URL}/latest-output`, {
        signal: AbortSignal.timeout(10000),
      });
      if (outputRes.ok) {
        const outputJson = await outputRes.json();
        latestStageMetadata = outputJson?.stage_metadata || null;
      }
    } catch {
      // Council unreachable — latestStageMetadata stays null
    }

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
        runStatus,
        latestStageMetadata,
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

// POST /api/admin/council — Trigger a council run (background)
export async function POST() {
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
