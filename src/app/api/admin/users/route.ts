import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, hashPassword } from '@/lib/auth';
import prisma from '@/lib/db/prisma';
import { sendPasswordResetEmail } from '@/lib/email/resend';
import crypto from 'crypto';

// GET /api/admin/users — List all users with activity stats
export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        role: true,
        lastLoginAt: true,
        createdAt: true,
        emailDailySpikes: true,
        emailSellReminders: true,
        emailDeviationAlerts: true,
        _count: {
          select: {
            portfolios: true,
            sessions: true,
          },
        },
      },
    });

    return NextResponse.json({
      success: true,
      data: users.map((u) => ({
        id: u.id,
        email: u.email,
        role: u.role,
        lastLoginAt: u.lastLoginAt,
        createdAt: u.createdAt,
        emailDailySpikes: u.emailDailySpikes,
        emailSellReminders: u.emailSellReminders,
        emailDeviationAlerts: u.emailDeviationAlerts,
        portfolioCount: u._count.portfolios,
        sessionCount: u._count.sessions,
      })),
    });
  } catch (error) {
    console.error('Admin users list error:', error);
    return NextResponse.json({ success: false, error: 'Failed to fetch users' }, { status: 500 });
  }
}

// PUT /api/admin/users — Reset a user's password
export async function PUT(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    const { userId } = await request.json();

    if (!userId) {
      return NextResponse.json({ success: false, error: 'userId required' }, { status: 400 });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return NextResponse.json({ success: false, error: 'User not found' }, { status: 404 });
    }

    // Generate 12-char temporary password
    const tempPassword = crypto.randomBytes(9).toString('base64url').slice(0, 12);
    const passwordHash = await hashPassword(tempPassword);

    await prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash,
        mustChangePassword: true,
        sessionVersion: { increment: 1 },
      },
    });

    // Send temp password email
    await sendPasswordResetEmail({ to: user.email, tempPassword });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Admin password reset error:', error);
    return NextResponse.json({ success: false, error: 'Failed to reset password' }, { status: 500 });
  }
}

// DELETE /api/admin/users — Remove a user account (cascade)
export async function DELETE(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    const { userId } = await request.json();

    if (!userId) {
      return NextResponse.json({ success: false, error: 'userId required' }, { status: 400 });
    }

    // Prevent admin from deleting themselves
    if (userId === admin.userId) {
      return NextResponse.json({ success: false, error: 'Cannot delete your own account' }, { status: 400 });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { portfolios: { select: { id: true } } },
    });

    if (!user) {
      return NextResponse.json({ success: false, error: 'User not found' }, { status: 404 });
    }

    // Cascade: delete portfolio entries, portfolios, sessions, then user
    const portfolioIds = user.portfolios.map((p) => p.id);

    if (portfolioIds.length > 0) {
      await prisma.portfolioEntry.deleteMany({
        where: { portfolioId: { in: portfolioIds } },
      });
      await prisma.portfolio.deleteMany({
        where: { id: { in: portfolioIds } },
      });
    }

    await prisma.userSession.deleteMany({ where: { userId } });

    // Clear invitation reference
    await prisma.invitation.updateMany({
      where: { usedById: userId },
      data: { usedById: null },
    });

    await prisma.user.delete({ where: { id: userId } });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Admin delete user error:', error);
    return NextResponse.json({ success: false, error: 'Failed to delete user' }, { status: 500 });
  }
}
