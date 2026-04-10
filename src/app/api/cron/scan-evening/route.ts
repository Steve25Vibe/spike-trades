import { NextRequest, NextResponse } from 'next/server';
import { runEveningScan } from '@/lib/scheduling/analyzer';
import { isTradingDay } from '@/lib/utils';

// Allow up to 1 hour for the council pipeline + archive write
export const maxDuration = 3600;

// POST /api/cron/scan-evening — Trigger the evening (post-close) council scan
// for tomorrow's pre-market planning. Writes EveningScanArchive + DailyReport
// + Spike rows with scanType='EVENING'. Does NOT send email in Phase 1
// (email infrastructure ships in Phase 2).
//
// Called by:
//   - cron container (Phase 2+): 8:00 PM ADT Mon-Fri
//   - manual trigger via SSH+curl (Phase 1 testing)
export async function POST(request: NextRequest) {
  // Verify Bearer token (same auth as the existing /api/cron endpoint)
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.SESSION_SECRET;

  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Skip on TSX holidays — there's no point running an evening scan on a
    // day that wasn't a trading day, because today's bars wouldn't exist.
    if (!isTradingDay(new Date())) {
      console.log('[Cron/Evening] Skipping evening scan — TSX closed (holiday)');
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: 'TSX closed (holiday)',
      });
    }

    console.log('[Cron/Evening] Triggering evening scan...');
    const result = await runEveningScan();
    console.log('[Cron/Evening] Evening scan completed:', JSON.stringify(result));

    return NextResponse.json(result);
  } catch (error) {
    console.error('[Cron/Evening] Evening scan failed:', error);
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
    purpose: 'evening scan trigger (v6.1.0 Phase 1)',
    nextRun: 'manual only (Phase 1) — 20:00 ADT in Phase 2+',
    timezone: 'America/Halifax',
  });
}
