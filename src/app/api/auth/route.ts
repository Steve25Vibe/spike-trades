import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyPassword } from '@/lib/auth';

export async function POST(request: NextRequest) {
  try {
    const { password } = await request.json();

    if (!password) {
      return NextResponse.json(
        { success: false, error: 'Password required' },
        { status: 400 }
      );
    }

    const valid = await verifyPassword(password);

    if (!valid) {
      return NextResponse.json(
        { success: false, error: 'Invalid password' },
        { status: 401 }
      );
    }

    const session = await getSession();
    session.isAuthenticated = true;
    session.loginAt = Date.now();
    await session.save();

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Auth error:', error);
    return NextResponse.json(
      { success: false, error: 'Authentication failed' },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  const session = await getSession();
  session.destroy();
  return NextResponse.json({ success: true });
}

export async function GET() {
  const session = await getSession();
  return NextResponse.json({
    authenticated: session.isAuthenticated === true,
  });
}
