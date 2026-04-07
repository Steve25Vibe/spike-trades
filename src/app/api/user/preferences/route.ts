import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth';
import prisma from '@/lib/db/prisma';

// GET /api/user/preferences — Get current user's email preferences
export async function GET() {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const prefs = await prisma.user.findUnique({
      where: { id: user.userId },
      select: {
        emailDailySpikes: true,
        emailSellReminders: true,
        emailDeviationAlerts: true,
        emailOpeningBell: true,
        emailRadar: true,
      },
    });

    return NextResponse.json({ success: true, data: prefs });
  } catch (error) {
    console.error('Preferences fetch error:', error);
    return NextResponse.json({ success: false, error: 'Failed to fetch preferences' }, { status: 500 });
  }
}

// PUT /api/user/preferences — Update email preferences
export async function PUT(request: NextRequest) {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { emailDailySpikes, emailSellReminders, emailDeviationAlerts, emailOpeningBell, emailRadar } = await request.json();

    const data: Record<string, boolean> = {};
    if (emailDailySpikes !== undefined) data.emailDailySpikes = Boolean(emailDailySpikes);
    if (emailSellReminders !== undefined) data.emailSellReminders = Boolean(emailSellReminders);
    if (emailDeviationAlerts !== undefined) data.emailDeviationAlerts = Boolean(emailDeviationAlerts);
    if (emailOpeningBell !== undefined) data.emailOpeningBell = Boolean(emailOpeningBell);
    if (emailRadar !== undefined) data.emailRadar = Boolean(emailRadar);

    await prisma.user.update({
      where: { id: user.userId },
      data,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Preferences update error:', error);
    return NextResponse.json({ success: false, error: 'Failed to update preferences' }, { status: 500 });
  }
}
