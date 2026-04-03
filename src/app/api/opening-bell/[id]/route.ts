import { NextRequest, NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import prisma from '@/lib/db/prisma';

// GET /api/opening-bell/[id] — Get a single Opening Bell pick by ID
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  try {
    const pick = await prisma.openingBellPick.findUnique({
      where: { id },
      include: { report: true },
    });

    if (!pick) {
      return NextResponse.json(
        { success: false, error: 'Opening Bell pick not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      data: pick,
    });
  } catch (error) {
    console.error('Error fetching Opening Bell pick:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch Opening Bell pick' },
      { status: 500 }
    );
  }
}
