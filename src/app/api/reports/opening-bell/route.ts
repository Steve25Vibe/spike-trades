import { NextRequest, NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import prisma from '@/lib/db/prisma';
import { parsePagination } from '@/lib/utils';

export async function GET(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { page, pageSize, skip } = parsePagination(request.nextUrl.searchParams);

  try {
    const [reports, total] = await Promise.all([
      prisma.openingBellReport.findMany({
        orderBy: { date: 'desc' },
        skip,
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
  } catch (error) {
    console.error('Opening Bell reports fetch error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch opening bell reports' },
      { status: 500 }
    );
  }
}
