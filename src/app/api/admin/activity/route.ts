import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import prisma from '@/lib/db/prisma';

// GET /api/admin/activity — User activity summary
export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // Total users
    const totalUsers = await prisma.user.count();

    // Active today (users with sessions starting today)
    const activeToday = await prisma.userSession.groupBy({
      by: ['userId'],
      where: { loginAt: { gte: todayStart } },
    });

    // Per-user activity
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        lastLoginAt: true,
        sessions: {
          select: { loginAt: true, duration: true },
          orderBy: { loginAt: 'desc' },
        },
      },
      orderBy: { lastLoginAt: 'desc' },
    });

    const perUser = users.map((u) => {
      const sessions = u.sessions;
      const sessionsWithDuration = sessions.filter((s) => s.duration !== null);
      const avgDuration = sessionsWithDuration.length > 0
        ? Math.round(sessionsWithDuration.reduce((sum, s) => sum + (s.duration || 0), 0) / sessionsWithDuration.length)
        : 0;

      return {
        email: u.email,
        totalSessions: sessions.length,
        avgDurationSec: avgDuration,
        lastActive: u.lastLoginAt,
      };
    });

    // Global average session duration
    const allDurations = users.flatMap((u) => u.sessions.filter((s) => s.duration).map((s) => s.duration || 0));
    const globalAvgDuration = allDurations.length > 0
      ? Math.round(allDurations.reduce((a, b) => a + b, 0) / allDurations.length)
      : 0;

    return NextResponse.json({
      success: true,
      data: {
        totalUsers,
        activeToday: activeToday.length,
        avgSessionDurationSec: globalAvgDuration,
        perUser,
      },
    });
  } catch (error) {
    console.error('Admin activity error:', error);
    return NextResponse.json({ success: false, error: 'Failed to fetch activity' }, { status: 500 });
  }
}
