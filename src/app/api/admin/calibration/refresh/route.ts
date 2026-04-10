import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';

const COUNCIL_API_URL = process.env.COUNCIL_API_URL || 'http://localhost:8100';

export async function POST() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    const res = await fetch(`${COUNCIL_API_URL}/calibration-refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(5_400_000),
    });
    const data = await res.json();
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}
