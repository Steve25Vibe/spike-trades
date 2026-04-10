import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import prisma from '@/lib/db/prisma';

// GET /api/admin/scans — Scan status for evening + morning scans
export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    // Evening scan status — derived from the latest DailyReport
    const latestReport = await prisma.dailyReport.findFirst({
      orderBy: { date: 'desc' },
      select: { date: true, generatedAt: true, _count: { select: { spikes: true } } },
    });

    // Morning scan status — derived from MorningScanArchive if it exists
    let morningData: { lastRun: string | null; pickCount: number | null; status: string } = {
      lastRun: null,
      pickCount: null,
      status: 'never',
    };

    try {
      // MorningScanArchive is being added by the backend instance — query raw to avoid
      // Prisma client errors if the table doesn't exist yet
      const rows = await prisma.$queryRaw<{ createdAt: Date; pickCount: number }[]>`
        SELECT "createdAt", "pickCount" FROM "MorningScanArchive"
        ORDER BY "createdAt" DESC LIMIT 1
      `;
      if (rows.length > 0) {
        morningData = {
          lastRun: rows[0].createdAt.toISOString(),
          pickCount: rows[0].pickCount,
          status: 'ok',
        };
      }
    } catch {
      // Table doesn't exist yet — that's fine, backend instance will create it
    }

    return NextResponse.json({
      success: true,
      data: {
        evening: {
          lastRun: latestReport?.generatedAt?.toISOString() ?? null,
          pickCount: latestReport?._count?.spikes ?? null,
          status: latestReport ? 'ok' : 'never',
        },
        morning: morningData,
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
