import { NextRequest, NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import prisma from '@/lib/db/prisma';

export async function GET(request: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const page = Math.max(1, parseInt(request.nextUrl.searchParams.get('page') || '1', 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(request.nextUrl.searchParams.get('pageSize') || '20', 10)));
  const skip = (page - 1) * pageSize;

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
      reports,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Internal server error' }, { status: 500 });
  }
}
