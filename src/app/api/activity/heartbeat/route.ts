import { NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth';
import prisma from '@/lib/db/prisma';

const IDLE_MS = 5 * 60 * 1000; // 5 minutes — gap that closes a session

// POST /api/activity/heartbeat — Extend or rotate the user's open session
export async function POST() {
  const user = await getAuthenticatedUser();
  if (!user) return new NextResponse(null, { status: 401 });

  const now = new Date();

  // Find this user's latest open session
  const open = await prisma.userSession.findFirst({
    where: { userId: user.userId, logoutAt: null },
    orderBy: { loginAt: 'desc' },
  });

  if (
    open &&
    open.lastHeartbeatAt &&
    now.getTime() - open.lastHeartbeatAt.getTime() < IDLE_MS
  ) {
    // Active session — extend it
    await prisma.userSession.update({
      where: { id: open.id },
      data: { lastHeartbeatAt: now },
    });
  } else {
    // No active session OR prior session went idle — close stale, open fresh
    if (open) {
      const closeAt = open.lastHeartbeatAt ?? open.loginAt;
      await prisma.userSession.update({
        where: { id: open.id },
        data: {
          logoutAt: closeAt,
          duration: Math.round((closeAt.getTime() - open.loginAt.getTime()) / 1000),
        },
      });
    }
    await prisma.userSession.create({
      data: { userId: user.userId, loginAt: now, lastHeartbeatAt: now },
    });
  }

  await prisma.user.update({
    where: { id: user.userId },
    data: { lastSeenAt: now },
  });

  return new NextResponse(null, { status: 204 });
}
