import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';

export async function GET(request: NextRequest) {
  const page = parseInt(request.nextUrl.searchParams.get('page') || '1');
  const pageSize = parseInt(request.nextUrl.searchParams.get('pageSize') || '20');
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
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
