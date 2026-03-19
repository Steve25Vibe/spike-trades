import { NextRequest, NextResponse } from 'next/server';
import { runDailyAnalysis } from '@/lib/scheduling/analyzer';

// POST /api/cron — Trigger daily analysis
// Called by node-cron scheduler or manually
export async function POST(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.SESSION_SECRET;

  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await runDailyAnalysis();
    return NextResponse.json(result);
  } catch (error) {
    console.error('[Cron] Analysis failed:', error);
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}

// GET for health check
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    nextRun: '10:45 AST daily',
    timezone: 'America/Halifax',
  });
}
