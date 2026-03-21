import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import prisma from '@/lib/db/prisma';
import { sendInvitationEmail } from '@/lib/email/resend';
import crypto from 'crypto';

function generateInviteCode(): string {
  const chars = crypto.randomBytes(6).toString('base64url').slice(0, 8).toUpperCase();
  return `ST-${chars}`;
}

// GET /api/admin/invites — List all invitations
export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    // Auto-expire past-due pending invitations
    await prisma.invitation.updateMany({
      where: {
        status: 'pending',
        expiresAt: { lt: new Date() },
      },
      data: { status: 'expired' },
    });

    const invitations = await prisma.invitation.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        code: true,
        email: true,
        status: true,
        expiresAt: true,
        createdAt: true,
        usedAt: true,
        usedBy: { select: { email: true } },
      },
    });

    return NextResponse.json({ success: true, data: invitations });
  } catch (error) {
    console.error('Admin invites list error:', error);
    return NextResponse.json({ success: false, error: 'Failed to fetch invitations' }, { status: 500 });
  }
}

// POST /api/admin/invites — Create and send an invitation
export async function POST(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    const { email } = await request.json();

    if (!email || !email.includes('@')) {
      return NextResponse.json({ success: false, error: 'Valid email required' }, { status: 400 });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existingUser) {
      return NextResponse.json({ success: false, error: 'User with this email already exists' }, { status: 409 });
    }

    // Check for existing pending invitation
    const existingInvite = await prisma.invitation.findFirst({
      where: { email: normalizedEmail, status: 'pending' },
    });
    if (existingInvite) {
      return NextResponse.json({ success: false, error: 'A pending invitation already exists for this email' }, { status: 409 });
    }

    const code = generateInviteCode();
    const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // 3 days

    const invitation = await prisma.invitation.create({
      data: {
        code,
        email: normalizedEmail,
        expiresAt,
      },
    });

    // Send invitation email
    await sendInvitationEmail({ to: normalizedEmail, code, expiresAt });

    return NextResponse.json({ success: true, data: invitation });
  } catch (error) {
    console.error('Admin create invite error:', error);
    return NextResponse.json({ success: false, error: 'Failed to create invitation' }, { status: 500 });
  }
}

// DELETE /api/admin/invites — Revoke a pending invitation
export async function DELETE(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    const { invitationId } = await request.json();

    if (!invitationId) {
      return NextResponse.json({ success: false, error: 'invitationId required' }, { status: 400 });
    }

    const invitation = await prisma.invitation.findUnique({ where: { id: invitationId } });
    if (!invitation || invitation.status !== 'pending') {
      return NextResponse.json({ success: false, error: 'Invitation not found or already used' }, { status: 404 });
    }

    await prisma.invitation.delete({ where: { id: invitationId } });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Admin revoke invite error:', error);
    return NextResponse.json({ success: false, error: 'Failed to revoke invitation' }, { status: 500 });
  }
}
