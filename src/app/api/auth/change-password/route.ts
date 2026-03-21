import { NextRequest, NextResponse } from 'next/server';
import {
  getSession,
  getAuthenticatedUser,
  verifyPassword,
  hashPassword,
  validatePasswordStrength,
} from '@/lib/auth';
import prisma from '@/lib/db/prisma';

// POST /api/auth/change-password — Change password (also handles forced reset)
export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { currentPassword, newPassword } = await request.json();

    if (!currentPassword || !newPassword) {
      return NextResponse.json(
        { success: false, error: 'Current password and new password are required' },
        { status: 400 }
      );
    }

    // Validate new password strength
    const strength = validatePasswordStrength(newPassword);
    if (!strength.valid) {
      return NextResponse.json(
        { success: false, error: strength.error },
        { status: 400 }
      );
    }

    // Verify current password
    const dbUser = await prisma.user.findUnique({
      where: { id: user.userId },
      select: { passwordHash: true, sessionVersion: true },
    });

    if (!dbUser) {
      return NextResponse.json({ success: false, error: 'User not found' }, { status: 404 });
    }

    const valid = await verifyPassword(currentPassword, dbUser.passwordHash);
    if (!valid) {
      return NextResponse.json(
        { success: false, error: 'Current password is incorrect' },
        { status: 401 }
      );
    }

    // Update password, clear mustChangePassword, increment sessionVersion
    const newHash = await hashPassword(newPassword);
    const newVersion = dbUser.sessionVersion + 1;

    await prisma.user.update({
      where: { id: user.userId },
      data: {
        passwordHash: newHash,
        mustChangePassword: false,
        sessionVersion: newVersion,
      },
    });

    // Update current session with new version so it stays valid
    const session = await getSession();
    session.sessionVersion = newVersion;
    await session.save();

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Change password error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to change password' },
      { status: 500 }
    );
  }
}
