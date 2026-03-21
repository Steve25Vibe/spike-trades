import { NextRequest, NextResponse } from 'next/server';
import { getIronSession } from 'iron-session';

interface SessionData {
  isAuthenticated: boolean;
  userId: string;
  role: 'admin' | 'user';
}

const sessionOptions = {
  password: process.env.SESSION_SECRET || 'spike-trades-session-secret-must-be-at-least-32-chars-long!!!',
  cookieName: 'spike-trades-session',
};

// Routes that don't require authentication
const PUBLIC_PATHS = [
  '/login',
  '/register',
  '/api/auth',
  '/_next',
  '/favicon.ico',
  '/images',
];

// Routes that require admin role
const ADMIN_PATHS = [
  '/admin',
  '/api/admin',
];

// System routes using Bearer token auth (not session-based)
const SYSTEM_PATHS = [
  '/api/cron',
  '/api/portfolio/alerts',
  '/api/accuracy/check',
];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname.startsWith(p));
}

function isAdminPath(pathname: string): boolean {
  return ADMIN_PATHS.some((p) => pathname.startsWith(p));
}

function isSystemPath(pathname: string): boolean {
  return SYSTEM_PATHS.some((p) => pathname.startsWith(p));
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Public routes — always allow
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // System/cron routes — bypass session auth (they use Bearer tokens)
  if (isSystemPath(pathname)) {
    return NextResponse.next();
  }

  // Root path — let the page.tsx handle redirect logic
  if (pathname === '/') {
    return NextResponse.next();
  }

  // Read session from cookie
  const response = NextResponse.next();
  try {
    const session = await getIronSession<SessionData>(request, response, sessionOptions);

    if (!session.isAuthenticated || !session.userId) {
      // Not authenticated — redirect to login
      if (pathname.startsWith('/api/')) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      return NextResponse.redirect(new URL('/login', request.url));
    }

    // Admin routes — check role
    if (isAdminPath(pathname) && session.role !== 'admin') {
      if (pathname.startsWith('/api/')) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      return NextResponse.redirect(new URL('/dashboard', request.url));
    }

    return response;
  } catch {
    // Session parsing failed — redirect to login
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.redirect(new URL('/login', request.url));
  }
}

export const config = {
  matcher: [
    // Match all routes except static files
    '/((?!_next/static|_next/image|favicon.ico|images/).*)',
  ],
};
