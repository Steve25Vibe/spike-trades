import { NextRequest, NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import prisma from '@/lib/db/prisma';

export async function GET(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
  const pageSize = Math.max(1, parseInt(searchParams.get('pageSize') || '20', 10));

  const [reports, total] = await Promise.all([
    prisma.openingBellReport.findMany({
      orderBy: { date: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        picks: {
          orderBy: { rank: 'asc' },
          take: 3,
          select: {
            ticker: true,
            momentumScore: true,
            changePercent: true,
            targetHit: true,
          },
        },
      },
    }),
    prisma.openingBellReport.count(),
  ]);

  const data = reports.map((report) => ({
    id: report.id,
    date: report.date.toISOString().split('T')[0],
    generatedAt: report.generatedAt.toISOString(),
    tickersScanned: report.tickersScanned,
    scanDurationMs: report.scanDurationMs,
    topPicks: report.picks,
  }));

  return NextResponse.json({ success: true, data, page, pageSize, total });
}
