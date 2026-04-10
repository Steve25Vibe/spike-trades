import { NextRequest, NextResponse } from 'next/server';
import { runDailyAnalysis } from '@/lib/scheduling/analyzer';
import { isTradingDay } from '@/lib/utils';

// Allow up to 1 hour for the council pipeline
export const maxDuration = 3600;

// POST /api/cron — Trigger daily analysis
// Called by node-cron scheduler or manually
// Query params: ?cached=true to use last council output (no new LLM calls)
export async function POST(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.SESSION_SECRET;

  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Skip on TSX holidays (cron runs weekdays but doesn't know about holidays)
    const useCached = request.nextUrl.searchParams.get('cached') === 'true';
    if (!useCached && !isTradingDay(new Date())) {
      console.log('[Cron] Skipping daily analysis — TSX closed (holiday)');
      return NextResponse.json({ success: true, skipped: true, reason: 'TSX closed (holiday)' });
    }

    const result = await runDailyAnalysis(useCached);
    return NextResponse.json(result);
  } catch (error) {
    console.error('[Cron] Analysis failed:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}

// GET for health check
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    nextRun: '11:15 ADT daily',
    timezone: 'America/Halifax',
  });
}
