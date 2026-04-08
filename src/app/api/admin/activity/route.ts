import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import prisma from '@/lib/db/prisma';

// GET /api/admin/activity — User activity summary (heartbeat-driven)
export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // Total users
    const totalUsers = await prisma.user.count();

    // Active today: users with at least one heartbeat since 00:00 today
    const activeTodayRows = await prisma.userSession.findMany({
      where: { lastHeartbeatAt: { gte: todayStart } },
      distinct: ['userId'],
      select: { userId: true },
    });
    const activeToday = activeTodayRows.length;

    // Per-user aggregate: COALESCE handles still-open sessions by treating
    // (lastHeartbeatAt - loginAt) as "duration so far" until the session closes
    const sessionsByUser = await prisma.$queryRaw<
      Array<{
        userId: string;
        sessions: number;
        avg_duration_sec: number | null;
        last_active: Date | null;
      }>
    >`
      SELECT
        "userId",
        COUNT(*)::int AS sessions,
        AVG(COALESCE(
          duration,
          EXTRACT(EPOCH FROM ("lastHeartbeatAt" - "loginAt"))::int
        ))::int AS avg_duration_sec,
        MAX("lastHeartbeatAt") AS last_active
      FROM "UserSession"
      WHERE "loginAt" >= NOW() - INTERVAL '30 days'
      GROUP BY "userId"
    `;

    // Join with User table for email
    const users = await prisma.user.findMany({
      select: { id: true, email: true },
    });
    const userById = new Map(users.map((u) => [u.id, u.email]));

    const perUser = sessionsByUser
      .map((row) => ({
        email: userById.get(row.userId) ?? '(unknown)',
        totalSessions: row.sessions,
        avgDurationSec: row.avg_duration_sec ?? 0,
        lastActive: row.last_active,
      }))
      .sort((a, b) => {
        const at = a.lastActive ? a.lastActive.getTime() : 0;
        const bt = b.lastActive ? b.lastActive.getTime() : 0;
        return bt - at;
      });

    // Global average session duration (same COALESCE logic, all users)
    const globalAvg = await prisma.$queryRaw<Array<{ avg_sec: number | null }>>`
      SELECT AVG(COALESCE(
        duration,
        EXTRACT(EPOCH FROM ("lastHeartbeatAt" - "loginAt"))::int
      ))::int AS avg_sec
      FROM "UserSession"
      WHERE "loginAt" >= NOW() - INTERVAL '30 days'
    `;
    const globalAvgDuration = globalAvg[0]?.avg_sec ?? 0;

    return NextResponse.json({
      success: true,
      data: {
        totalUsers,
        activeToday,
        avgSessionDurationSec: globalAvgDuration,
        perUser,
      },
    });
  } catch (error) {
    console.error('Admin activity error:', error);
    return NextResponse.json({ success: false, error: 'Failed to fetch activity' }, { status: 500 });
  }
}
