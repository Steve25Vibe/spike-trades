import { NextRequest, NextResponse } from 'next/server';
import { runMorningScan } from '@/lib/scheduling/analyzer';
import { isTradingDay } from '@/lib/utils';

// Allow up to 1 hour for the council pipeline
export const maxDuration = 3600;

// POST /api/cron — DEPRECATED: Use /api/cron/scan-morning instead.
// Kept for backward compatibility with existing cron container config.
// Delegates to runMorningScan() (same as /api/cron/scan-morning).
export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.SESSION_SECRET;

  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const useCached = request.nextUrl.searchParams.get('cached') === 'true';

    if (!useCached && !isTradingDay(new Date())) {
      console.log('[Cron] Skipping — TSX closed (holiday)');
      return NextResponse.json({ success: true, skipped: true, reason: 'TSX closed (holiday)' });
    }

    console.warn('[Cron] DEPRECATED: /api/cron called — use /api/cron/scan-morning instead');
    const result = await runMorningScan(useCached);
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
    deprecated: true,
    message: 'Use /api/cron/scan-morning instead',
    nextRun: '11:15 ADT daily',
    timezone: 'America/Halifax',
  });
}
