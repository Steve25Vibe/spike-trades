import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';

const COUNCIL_URL = process.env.COUNCIL_API_URL || 'http://council:8100';

export async function GET() {
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(`${COUNCIL_URL}/learning-state`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const data = await res.json();
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error('Learning state fetch error:', error);
    return NextResponse.json(
      { success: true, data: { success: false, error: 'Council server unreachable' } },
      { status: 200 }
    );
  }
}
