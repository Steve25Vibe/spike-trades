// ============================================
// Authentication — Multi-user email + password
// Uses iron-session for encrypted cookie sessions
// ============================================

import { getIronSession, IronSession } from 'iron-session';
import { cookies } from 'next/headers';
import bcrypt from 'bcryptjs';
import prisma from '@/lib/db/prisma';

export interface SessionData {
  isAuthenticated: boolean;
  userId: string;
  email: string;
  role: 'admin' | 'user';
  sessionVersion: number;
  sessionId?: string; // UserSession record ID for tracking
  loginAt?: number;
}

export interface AuthUser {
  userId: string;
  email: string;
  role: 'admin' | 'user';
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

export async function getSession(): Promise<IronSession<SessionData>> {
  const cookieStore = await cookies();
  return getIronSession<SessionData>(cookieStore, sessionOptions);
}

/**
 * Verify a plaintext password against a bcrypt hash.
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Hash a plaintext password with bcrypt.
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

/**
 * Validate password strength: 8+ chars, uppercase, lowercase, digit.
 */
export function validatePasswordStrength(password: string): { valid: boolean; error?: string } {
  if (password.length < 8) return { valid: false, error: 'Password must be at least 8 characters' };
  if (!/[a-z]/.test(password)) return { valid: false, error: 'Password must contain a lowercase letter' };
  if (!/[A-Z]/.test(password)) return { valid: false, error: 'Password must contain an uppercase letter' };
  if (!/\d/.test(password)) return { valid: false, error: 'Password must contain a number' };
  return { valid: true };
}

/**
 * Get the authenticated user from the session.
 * Validates sessionVersion against the database to catch password resets.
 * Returns null if not authenticated or session is invalidated.
 */
export async function getAuthenticatedUser(): Promise<AuthUser | null> {
  try {
    const session = await getSession();
    if (!session.isAuthenticated || !session.userId) return null;

    // Verify sessionVersion matches DB (catches password resets)
    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { id: true, email: true, role: true, sessionVersion: true },
    });

    if (!user) return null;
    if (user.sessionVersion !== session.sessionVersion) {
      // Session invalidated (e.g. password was reset)
      session.destroy();
      return null;
    }

    return {
      userId: user.id,
      email: user.email,
      role: user.role as 'admin' | 'user',
    };
  } catch {
    return null;
  }
}

/**
 * Require admin role. Returns AuthUser or null.
 */
export async function requireAdmin(): Promise<AuthUser | null> {
  const user = await getAuthenticatedUser();
  if (!user || user.role !== 'admin') return null;
  return user;
}

/**
 * Simple backward-compatible auth check.
 */
export async function isAuthenticated(): Promise<boolean> {
  const user = await getAuthenticatedUser();
  return user !== null;
}

// ---- Rate Limiting ----

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Check rate limit for an IP. Returns true if allowed, false if blocked.
 */
export function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX) return false;

  entry.count++;
  return true;
}

/**
 * Record a failed auth attempt for rate limiting.
 */
export function recordFailedAttempt(ip: string): void {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
  } else {
    entry.count++;
  }
}

/**
 * Clear rate limit for an IP (e.g. after successful login).
 */
export function clearRateLimit(ip: string): void {
  rateLimitMap.delete(ip);
}
