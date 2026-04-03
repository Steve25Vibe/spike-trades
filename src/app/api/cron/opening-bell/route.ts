import { NextRequest, NextResponse } from 'next/server';
import { runOpeningBellAnalysis } from '@/lib/opening-bell-analyzer';
import { isTradingDay } from '@/lib/utils';

// Allow up to 10 minutes for the Opening Bell pipeline
export const maxDuration = 600;

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.SESSION_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    if (!isTradingDay(new Date())) {
      console.log('[Cron] Skipping Opening Bell — TSX closed (holiday)');
      return NextResponse.json({ success: true, skipped: true, reason: 'TSX closed (holiday)' });
    }

    const result = await runOpeningBellAnalysis();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}
