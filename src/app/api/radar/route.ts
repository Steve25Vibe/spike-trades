import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db/prisma';

export async function GET(request: NextRequest) {
  const dateParam = request.nextUrl.searchParams.get('date');

  try {
    let dateFilter: Date;
    if (dateParam) {
      dateFilter = new Date(dateParam);
    } else {
      dateFilter = new Date();
    }
    dateFilter.setHours(0, 0, 0, 0);

    const report = await prisma.radarReport.findUnique({
      where: { date: dateFilter },
      include: {
        picks: { orderBy: { rank: 'asc' } },
      },
    });

    if (!report) {
      // Fallback: get most recent report
      const latest = await prisma.radarReport.findFirst({
        orderBy: { date: 'desc' },
        include: {
          picks: { orderBy: { rank: 'asc' } },
        },
      });

      if (!latest) {
        return NextResponse.json({ report: null, picks: [] });
      }
      return NextResponse.json({ report: latest, picks: latest.picks });
    }

    return NextResponse.json({ report, picks: report.picks });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
