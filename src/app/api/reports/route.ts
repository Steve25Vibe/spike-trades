import { NextRequest, NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import prisma from '@/lib/db/prisma';

// GET /api/reports — List all daily reports
export async function GET(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const page = Math.max(1, parseInt(request.nextUrl.searchParams.get('page') || '1', 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(request.nextUrl.searchParams.get('pageSize') || '30', 10)));

  try {
    const [reports, total] = await Promise.all([
      prisma.dailyReport.findMany({
        orderBy: { date: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          spikes: {
            orderBy: { rank: 'asc' },
            take: 3, // Top 3 for preview
            select: {
              ticker: true,
              spikeScore: true,
              predicted3Day: true,
              actual3Day: true,
            },
          },
        },
      }),
      prisma.dailyReport.count(),
    ]);

    return NextResponse.json({
      success: true,
      data: reports.map((r) => ({
        id: r.id,
        date: r.date,
        marketRegime: r.marketRegime,
        tsxLevel: r.tsxLevel,
        tsxChange: r.tsxChange,
        csvUrl: r.csvUrl,
        topSpikes: r.spikes,
      })),
      page,
      pageSize,
      total,
    });
  } catch (error) {
    console.error('Reports fetch error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch reports' },
      { status: 500 }
    );
  }
}
