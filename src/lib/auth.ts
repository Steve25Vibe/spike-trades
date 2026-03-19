// ============================================
// Authentication — Password-protected site
// Uses iron-session for encrypted cookie sessions
// ============================================

import { getIronSession, IronSession } from 'iron-session';
import { cookies } from 'next/headers';
import bcrypt from 'bcryptjs';

export interface SessionData {
  isAuthenticated: boolean;
  loginAt?: number;
}

const sessionOptions = {
  password: process.env.SESSION_SECRET || 'spike-trades-session-secret-must-be-at-least-32-chars-long!!!',
  cookieName: 'spike-trades-session',
  cookieOptions: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax' as const,
    maxAge: 60 * 60 * 24 * 30, // 30 days
  },
};

// Pre-computed bcrypt hash of 'godmode'
const PASSWORD_HASH = process.env.APP_PASSWORD_HASH ||
  bcrypt.hashSync('godmode', 12);

export async function getSession(): Promise<IronSession<SessionData>> {
  const cookieStore = await cookies();
  return getIronSession<SessionData>(cookieStore, sessionOptions);
}

export async function verifyPassword(password: string): Promise<boolean> {
  return bcrypt.compare(password, PASSWORD_HASH);
}

export async function isAuthenticated(): Promise<boolean> {
  try {
    const session = await getSession();
    return session.isAuthenticated === true;
  } catch {
    return false;
  }
}
