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
      prisma.radarReport.findMany({
        skip,
        take: pageSize,
        orderBy: { date: 'desc' },
        include: {
          picks: {
            orderBy: { rank: 'asc' },
            take: 5, // Top 5 for summary
          },
        },
      }),
      prisma.radarReport.count(),
    ]);

    return NextResponse.json({
      success: true,
      data: reports,
      page,
      pageSize,
      total,
    });
  } catch (error) {
    console.error('Radar reports fetch error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch radar reports' },
      { status: 500 }
    );
  }
}
