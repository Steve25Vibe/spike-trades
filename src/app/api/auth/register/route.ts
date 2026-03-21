import { NextRequest, NextResponse } from 'next/server';
import {
  getSession,
  hashPassword,
  validatePasswordStrength,
  checkRateLimit,
  recordFailedAttempt,
  clearRateLimit,
} from '@/lib/auth';
import prisma from '@/lib/db/prisma';

// POST /api/auth/register — Create account with invitation code
export async function POST(request: NextRequest) {
  try {
    const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';

    if (!checkRateLimit(ip)) {
      return NextResponse.json(
        { success: false, error: 'Too many attempts. Please try again in 15 minutes.' },
        { status: 429 }
      );
    }

    const { email, password, invitationCode } = await request.json();

    if (!email || !password || !invitationCode) {
      return NextResponse.json(
        { success: false, error: 'Email, password, and invitation code are required' },
        { status: 400 }
      );
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Validate invitation code
    const invitation = await prisma.invitation.findUnique({
      where: { code: invitationCode.toUpperCase().trim() },
    });

    if (!invitation) {
      recordFailedAttempt(ip);
      return NextResponse.json(
        { success: false, error: 'Invalid invitation code' },
        { status: 400 }
      );
    }

    if (invitation.status !== 'pending') {
      return NextResponse.json(
        { success: false, error: 'This invitation has already been used' },
        { status: 400 }
      );
    }

    if (new Date() > invitation.expiresAt) {
      // Auto-expire
      await prisma.invitation.update({
        where: { id: invitation.id },
        data: { status: 'expired' },
      });
      return NextResponse.json(
        { success: false, error: 'This invitation has expired' },
        { status: 400 }
      );
    }

    if (invitation.email.toLowerCase() !== normalizedEmail) {
      return NextResponse.json(
        { success: false, error: 'Email does not match the invitation' },
        { status: 400 }
      );
    }

    // Check if email is already registered
    const existingUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (existingUser) {
      return NextResponse.json(
        { success: false, error: 'An account with this email already exists' },
        { status: 409 }
      );
    }

    // Validate password strength
    const strength = validatePasswordStrength(password);
    if (!strength.valid) {
      return NextResponse.json(
        { success: false, error: strength.error },
        { status: 400 }
      );
    }

    // Create user
    const passwordHash = await hashPassword(password);
    const user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        passwordHash,
        role: 'user',
      },
    });

    // Mark invitation as accepted
    await prisma.invitation.update({
      where: { id: invitation.id },
      data: {
        status: 'accepted',
        usedAt: new Date(),
        usedById: user.id,
      },
    });

    // Clear rate limit on success
    clearRateLimit(ip);

    // Auto-login: create session
    const userSession = await prisma.userSession.create({
      data: { userId: user.id },
    });

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const session = await getSession();
    session.isAuthenticated = true;
    session.userId = user.id;
    session.email = user.email;
    session.role = 'user';
    session.sessionVersion = 1;
    session.sessionId = userSession.id;
    session.loginAt = Date.now();
    await session.save();

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Registration error:', error);
    return NextResponse.json(
      { success: false, error: 'Registration failed' },
      { status: 500 }
    );
  }
}
