import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import prisma from '@/lib/db/prisma';

// GET /api/admin/scans — Scan status for evening + morning scans
export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    // Query both archive tables in parallel
    const [eveningArchive, morningArchive] = await Promise.all([
      prisma.eveningScanArchive.findFirst({
        orderBy: { scanGeneratedAt: 'desc' },
        select: { scanDate: true, scanGeneratedAt: true, topPicksJson: true },
      }).catch(() => null),
      prisma.morningScanArchive.findFirst({
        orderBy: { scanGeneratedAt: 'desc' },
        select: { scanDate: true, scanGeneratedAt: true, topPicksJson: true },
      }).catch(() => null),
    ]);

    const countPicks = (json: unknown): number | null => {
      if (Array.isArray(json)) return json.length;
      return null;
    };

    return NextResponse.json({
      success: true,
      data: {
        evening: {
          lastRun: eveningArchive?.scanGeneratedAt?.toISOString() ?? null,
          pickCount: eveningArchive ? countPicks(eveningArchive.topPicksJson) : null,
          status: eveningArchive ? 'ok' : 'never',
        },
        morning: {
          lastRun: morningArchive?.scanGeneratedAt?.toISOString() ?? null,
          pickCount: morningArchive ? countPicks(morningArchive.topPicksJson) : null,
          status: morningArchive ? 'ok' : 'never',
        },
      },
    });
  } catch (error) {
    console.error('[Admin/Scans] Failed:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch scan status' },
      { status: 500 }
    );
  }
}
