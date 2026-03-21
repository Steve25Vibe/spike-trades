import { NextRequest, NextResponse } from 'next/server';
import {
  getSession,
  verifyPassword,
  getAuthenticatedUser,
  checkRateLimit,
  recordFailedAttempt,
  clearRateLimit,
} from '@/lib/auth';
import prisma from '@/lib/db/prisma';

// POST /api/auth — Login with email + password
export async function POST(request: NextRequest) {
  try {
    const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';

    if (!checkRateLimit(ip)) {
      return NextResponse.json(
        { success: false, error: 'Too many login attempts. Please try again in 15 minutes.' },
        { status: 429 }
      );
    }

    const { email, password } = await request.json();

    if (!email || !password) {
      return NextResponse.json(
        { success: false, error: 'Email and password required' },
        { status: 400 }
      );
    }

    // Look up user by email
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        role: true,
        mustChangePassword: true,
        sessionVersion: true,
      },
    });

    if (!user) {
      recordFailedAttempt(ip);
      return NextResponse.json(
        { success: false, error: 'Invalid email or password' },
        { status: 401 }
      );
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      recordFailedAttempt(ip);
      return NextResponse.json(
        { success: false, error: 'Invalid email or password' },
        { status: 401 }
      );
    }

    // Clear rate limit on successful login
    clearRateLimit(ip);

    // Create UserSession record
    const userSession = await prisma.userSession.create({
      data: { userId: user.id },
    });

    // Update last login
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    // Set session cookie
    const session = await getSession();
    session.isAuthenticated = true;
    session.userId = user.id;
    session.email = user.email;
    session.role = user.role as 'admin' | 'user';
    session.sessionVersion = user.sessionVersion;
    session.sessionId = userSession.id;
    session.loginAt = Date.now();
    await session.save();

    return NextResponse.json({
      success: true,
      mustChangePassword: user.mustChangePassword,
    });
  } catch (error) {
    console.error('Auth error:', error);
    return NextResponse.json(
      { success: false, error: 'Authentication failed' },
      { status: 500 }
    );
  }
}

// DELETE /api/auth — Logout
export async function DELETE() {
  const session = await getSession();

  // Update UserSession with logout time
  if (session.sessionId && session.loginAt) {
    try {
      const duration = Math.round((Date.now() - session.loginAt) / 1000);
      await prisma.userSession.update({
        where: { id: session.sessionId },
        data: { logoutAt: new Date(), duration },
      });
    } catch {
      // Session record may not exist — not critical
    }
  }

  session.destroy();
  return NextResponse.json({ success: true });
}

// GET /api/auth — Check session status
export async function GET() {
  const user = await getAuthenticatedUser();
  if (!user) {
    return NextResponse.json({ authenticated: false });
  }

  // Check mustChangePassword flag
  const dbUser = await prisma.user.findUnique({
    where: { id: user.userId },
    select: { mustChangePassword: true },
  });

  return NextResponse.json({
    authenticated: true,
    email: user.email,
    role: user.role,
    mustChangePassword: dbUser?.mustChangePassword || false,
  });
}
