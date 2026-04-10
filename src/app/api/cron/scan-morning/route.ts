import { NextRequest, NextResponse } from 'next/server';
import { runMorningScan } from '@/lib/scheduling/analyzer';
import { isTradingDay } from '@/lib/utils';

// Allow up to 1 hour for the council pipeline + archive write
export const maxDuration = 3600;

// POST /api/cron/scan-morning — Trigger the morning (pre-market) council scan
// for today's trading day. Writes MorningScanArchive + DailyReport + Spike rows
// with scanType='MORNING'. Sends standard morning email via sendCouncilEmail().
//
// Called by:
//   - cron container: 11:15 AM ADT Mon-Fri
//   - manual trigger via SSH+curl
export async function POST(request: NextRequest) {
  // Verify Bearer token (same auth as the existing /api/cron endpoint)
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.SESSION_SECRET;

  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Skip on TSX holidays — there's no point running a morning scan on a
    // day that isn't a trading day, because today's bars won't exist.
    if (!isTradingDay(new Date())) {
      console.log('[Cron/Morning] Skipping morning scan — TSX closed (holiday)');
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: 'TSX closed (holiday)',
      });
    }

    console.log('[Cron/Morning] Triggering morning scan...');
    const result = await runMorningScan();
    console.log('[Cron/Morning] Morning scan completed:', JSON.stringify(result));

    return NextResponse.json(result);
  } catch (error) {
    console.error('[Cron/Morning] Morning scan failed:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 }
    );
  }
}

// GET for health check (consistent with existing /api/cron endpoint)
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    purpose: 'morning scan trigger (v6.1.0 Phase 2)',
    nextRun: '11:15 ADT Mon-Fri',
    timezone: 'America/Halifax',
  });
}
