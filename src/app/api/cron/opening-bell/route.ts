import { NextRequest, NextResponse } from 'next/server';
import { runOpeningBellAnalysis } from '@/lib/opening-bell-analyzer';

// Allow up to 10 minutes for the Opening Bell pipeline
export const maxDuration = 600;

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.SESSION_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await runOpeningBellAnalysis();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}
