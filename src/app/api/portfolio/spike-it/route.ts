import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';

const COUNCIL_API_URL = process.env.COUNCIL_API_URL || 'http://localhost:8100';

export async function POST(request: Request) {
  try {
    // Authenticate — Spike It requires a logged-in user
    const session = await getSession();
    if (!session.isAuthenticated || !session.userId) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { ticker, entryPrice } = body;

    if (!ticker || typeof entryPrice !== 'number') {
      return NextResponse.json(
        { error: 'Missing required fields: ticker (string), entryPrice (number)' },
        { status: 400 }
      );
    }

    const res = await fetch(`${COUNCIL_API_URL}/spike-it`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticker,
        entry_price: entryPrice,
        user_id: session.userId,
        is_admin: session.role === 'admin',
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const errText = await res.text();
      return NextResponse.json(
        { error: `Council service error: ${errText}` },
        { status: res.status }
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      return NextResponse.json(
        { error: 'Analysis timed out — try again in a moment' },
        { status: 504 }
      );
    }
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
