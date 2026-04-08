# User Activity Heartbeat — Design Spec

**Date:** 2026-04-08
**Author:** Steven Weagle (with Claude)
**Status:** Draft, awaiting user review
**Topic:** Replace broken login-event tracking with real activity-presence tracking on the admin User Activity dashboard

---

## Problem

The Admin Panel "User Activity" dashboard at `/admin` (Activity tab) shows nonsensical data:

- Two users show **21.4h** and **22.0h** average session duration (a full day, not a session)
- Three users show **0s** average session duration
- "Active Today" reports **0** during a window when users are demonstrably on the site

### Root cause

`src/app/api/admin/activity/route.ts` reads from `UserSession`, whose lifecycle is:

| Event | Code path | Effect |
|---|---|---|
| Login | `POST /api/auth` (`src/app/api/auth/route.ts:67`) | INSERT row, `loginAt = now`, `logoutAt` and `duration` left NULL |
| Explicit logout | `DELETE /api/auth` (`src/app/api/auth/route.ts:106`) | UPDATE `logoutAt = now`, `duration = (now − loginAt) / 1000` |
| Tab close, cookie expiry, "just left" | none | Row stays open with NULL `duration` forever |

Symptoms map cleanly to this lifecycle:

- **Users at 0s** never explicitly logged out. Every session row has NULL duration → average is 0.
- **Users at 21–22h** did hit explicit logout — but only after leaving the tab open all day. `duration = (now − loginAt)` records a 21-hour "session".
- **Active Today = 0** because the dashboard query filters on `loginAt >= today 00:00`. Users on yesterday's still-valid cookie do not re-trigger `loginAt`, so they never count as "active today" until they re-login.

The category mistake: **the dashboard is wired to login events, not user activity.** A user who opens the site every day for a week without logging out shows as 1 session, 0s duration, last active = day-1.

---

## Goal

Replace the login-event signal with a presence-based signal that answers the engagement question truthfully:

- **Active Today** = users actually present on the site since 00:00 today
- **Avg Session** = realistic minute-scale durations of real visits
- **Last Active** = the moment the user was last actually on the site
- **Sessions per user** = count of distinct visits in the last 30 days

Out of scope: per-feature usage tracking, page-view logs, behavior analytics. (Reserved for a future spec if needed.)

---

## Approach

A client-side **activity heartbeat** that pings the server every 60 seconds while the tab is visible. The server uses these pings to track open sessions and bump a `lastSeenAt` field on the user.

### Why heartbeat over alternatives

Two alternatives were considered and rejected:

| Option | Why rejected |
|---|---|
| Server-side `lastSeenAt` bump on every authenticated request | Misses passive viewing. A user reading a long report for 8 minutes without clicking would show as "gone" after 5 min. Undercounts the most engaged users. |
| Hybrid (heartbeat + per-request bump) | Marginal accuracy improvement over heartbeat alone is not worth the extra surface area at 5-user scale. |

Heartbeat is the standard pattern for engagement metrics. It catches passive viewing, ignores hidden tabs (Alt+Tab away → no heartbeat → not counted as active), and handles tab-close cleanly via `keepalive: true`.

---

## Architecture

Three components, all small.

### Component 1: `POST /api/activity/heartbeat` (NEW)

**Location:** `src/app/api/activity/heartbeat/route.ts`

```ts
import { NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth';
import prisma from '@/lib/db/prisma';

const IDLE_MS = 5 * 60 * 1000; // 5 minutes

export async function POST() {
  const user = await getAuthenticatedUser();
  if (!user) return new NextResponse(null, { status: 401 });

  const now = new Date();

  const open = await prisma.userSession.findFirst({
    where: { userId: user.userId, logoutAt: null },
    orderBy: { loginAt: 'desc' },
  });

  if (
    open &&
    open.lastHeartbeatAt &&
    now.getTime() - open.lastHeartbeatAt.getTime() < IDLE_MS
  ) {
    // Active session — extend it
    await prisma.userSession.update({
      where: { id: open.id },
      data: { lastHeartbeatAt: now },
    });
  } else {
    // No active session, OR prior session went idle: close stale + open fresh
    if (open) {
      const closeAt = open.lastHeartbeatAt ?? open.loginAt;
      await prisma.userSession.update({
        where: { id: open.id },
        data: {
          logoutAt: closeAt,
          duration: Math.round((closeAt.getTime() - open.loginAt.getTime()) / 1000),
        },
      });
    }
    await prisma.userSession.create({
      data: { userId: user.userId, loginAt: now, lastHeartbeatAt: now },
    });
  }

  await prisma.user.update({
    where: { id: user.userId },
    data: { lastSeenAt: now },
  });

  return new NextResponse(null, { status: 204 });
}
```

**Properties:**
- All session lifecycle work happens lazily inside the heartbeat path. **No background cron required.**
- Idempotent within the 5-minute window: extra heartbeats only bump `lastHeartbeatAt`.
- 401 on unauthenticated requests; 204 on success.
- Stale-open sessions belonging to users who never return are handled by the dashboard's lazy-compute query (Component 3).

### Component 2: `<ActivityHeartbeat />` client component (NEW)

**Location:** `src/components/ActivityHeartbeat.tsx`

```tsx
'use client';
import { useEffect } from 'react';

export function ActivityHeartbeat() {
  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;

    const sendBeat = () => {
      if (cancelled || document.visibilityState !== 'visible') return;
      fetch('/api/activity/heartbeat', {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
      }).catch(() => {}); // silent fail
    };

    fetch('/api/auth', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled || !data?.authenticated) return;
        sendBeat(); // immediate first beat
        const interval = setInterval(sendBeat, 60_000);
        const onVis = () => {
          if (document.visibilityState === 'visible') sendBeat();
        };
        document.addEventListener('visibilitychange', onVis);
        cleanup = () => {
          clearInterval(interval);
          document.removeEventListener('visibilitychange', onVis);
        };
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  return null;
}
```

**Mounted in:** `src/app/layout.tsx` next to existing root content. The component self-gates on `/api/auth` so unauthenticated visitors do not ping.

**Behavior:**
- First beat fires within ~50ms of mount → Active Today populates instantly on a fresh page load
- 60-second intervals while `document.visibilityState === 'visible'`
- `visibilitychange` listener fires an immediate beat when the user Alt+Tabs back to the tab — no false-idle on quick context switches
- `keepalive: true` allows the request to survive tab close (browsers honor it for small POSTs); the final beat before closing the tab generally gets through
- Silent failure: heartbeat errors are swallowed. The dashboard is observability, not user-facing flow.

### Component 3: Dashboard query update (MODIFIED)

**Location:** `src/app/api/admin/activity/route.ts`

Replace the existing `prisma.user.findMany({ ... sessions: ... })` block with a raw aggregation that uses `lastHeartbeatAt` and computes duration lazily for still-open sessions:

```ts
const sessionsByUser = await prisma.$queryRaw<
  Array<{
    userId: string;
    sessions: number;
    avg_duration_sec: number;
    last_active: Date | null;
  }>
>`
  SELECT
    "userId",
    COUNT(*)::int AS sessions,
    AVG(COALESCE(
      duration,
      EXTRACT(EPOCH FROM ("lastHeartbeatAt" - "loginAt"))::int
    ))::int AS avg_duration_sec,
    MAX("lastHeartbeatAt") AS last_active
  FROM "UserSession"
  WHERE "loginAt" >= NOW() - INTERVAL '30 days'
  GROUP BY "userId"
`;
```

`Active Today` becomes:

```ts
const activeToday = await prisma.userSession.findMany({
  where: { lastHeartbeatAt: { gte: todayStart } },
  distinct: ['userId'],
  select: { userId: true },
});
```

Global `avgSessionDurationSec` is the equivalent COALESCE-aware aggregate over the same 30-day window.

The per-user response is then assembled by joining `sessionsByUser` with the `User` table on `id` for the email column.

---

## Data model changes

```prisma
model User {
  // ... existing fields preserved ...
  lastLoginAt   DateTime?    // unchanged — last sign-in event
  lastSeenAt    DateTime?    // NEW — last heartbeat received
  // ...
}

model UserSession {
  id                String    @id @default(cuid())
  userId            String
  user              User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  loginAt           DateTime  @default(now())
  logoutAt          DateTime?    // unchanged semantics; now closed by heartbeat path, not by explicit logout
  duration          Int?         // unchanged: seconds, computed from logoutAt − loginAt
  lastHeartbeatAt   DateTime?    // NEW — last activity ping while session was open

  @@index([userId])
  @@index([loginAt])
  @@index([lastHeartbeatAt])    // NEW — for "active today" queries
}
```

Two new fields, one new index. Backward-compatible additive Prisma migration.

---

## Migration: scoped data wipe

```sql
-- prisma/migrations/<timestamp>_user_activity_heartbeat/migration.sql

-- 1. Schema additions (additive, zero-downtime)
ALTER TABLE "User"        ADD COLUMN "lastSeenAt"      TIMESTAMP(3);
ALTER TABLE "UserSession" ADD COLUMN "lastHeartbeatAt" TIMESTAMP(3);
CREATE INDEX "UserSession_lastHeartbeatAt_idx" ON "UserSession"("lastHeartbeatAt");

-- 2. Pre-flight count (logged for audit, not enforced)
DO $$
DECLARE row_count int;
BEGIN
  SELECT COUNT(*) INTO row_count FROM "UserSession";
  RAISE NOTICE 'About to delete % UserSession rows (legacy data, pre-heartbeat)', row_count;
END $$;

-- 3. Scoped wipe of contaminated legacy data
DELETE FROM "UserSession" WHERE "loginAt" < NOW();
```

### Why scoped DELETE

Per the project's hard rule against unconditional deletes:
- **Never** `DELETE FROM "UserSession"` without a `WHERE` clause
- The `WHERE "loginAt" < NOW()` clause is honest: "delete everything that exists at migration time"
- **Race-safe:** if a heartbeat fires mid-migration and inserts a row, that row has `loginAt = NOW()` and is not in scope of `< NOW()`, so it survives the wipe
- The pre-flight `RAISE NOTICE` prints the row count to the deploy log so the operator sees exactly what got removed

### Why wipe at all

The legacy data is contaminated by two distinct bugs (NULL durations from missing logouts; 21h durations from tab-open-overnight cases). It cannot be used as a directional baseline because good and bad readings cannot be separated. Mixing legacy rows with new heartbeat-derived rows in a single 30-day window would produce a meaningless blended average. A clean slate is more useful than contaminated history.

The only historically valuable data — `User.createdAt` (when each user was invited) and `User.lastLoginAt` — lives on the `User` table, which is **not** modified.

---

## Auth + cookie impact: zero

The wipe does not affect any of the following:

| Concern | Why it is unaffected |
|---|---|
| User passwords | `User.passwordHash` is on the `User` table, untouched |
| Browser-saved passwords (Chrome / 1Password / Safari Keychain) | Stored client-side; the email/password combo on the server is unchanged |
| Currently logged-in users (cookies) | Verified at `src/lib/auth.ts:73-99`: `getAuthenticatedUser()` validates the cookie by looking up the `User` table and comparing `sessionVersion`. It **does not** look up the `UserSession` row. Wiping `UserSession` is invisible to the auth check. |
| Existing cookie's stale `sessionId` reference | `DELETE /api/auth` (`src/app/api/auth/route.ts:106-116`) already wraps `userSession.update` in a try/catch precisely for the missing-row case. Existing logout flow degrades gracefully. |
| First heartbeat from existing logged-in user post-deploy | No matching open `UserSession` exists (because of the wipe), so the heartbeat path falls through to `create()` and starts a fresh session. |

The deploy is invisible to the user. They keep their cookie, their saved password, and their portfolio data.

---

## Configuration

Locked-in defaults for this spec:

| Constant | Value | Rationale |
|---|---|---|
| Heartbeat interval (client) | 60 s | 1 req/min × 5 users = trivial server load |
| Idle threshold (server) | 5 min | 4 missed beats before close; tolerates brief network blips |
| Activity window for dashboard | 30 days | Rolling, self-cleaning |
| Mount point for heartbeat client | `src/app/layout.tsx` (root) | Self-gates on auth; no route-group restructure needed |
| Endpoint auth | `getAuthenticatedUser()` (existing) | Same gate as everything else |
| HTTP success response | 204 No Content | Minimal payload |

---

## Out of scope (YAGNI)

- No new cron job (lazy session close on next heartbeat is sufficient for 5 users)
- No `UserSession_archive` table (the wipe is final, agreed)
- No per-page-view event log
- No per-feature usage tracking
- No "currently online" live indicator (could be added later from `lastHeartbeatAt < 5 min ago`)
- No client-side retry on failed heartbeats (silent fail; next 60s tick will succeed)
- No admin UI markup changes — `src/app/admin/page.tsx` Activity tab markup is already correct, only the data values were broken
- No new dependencies

---

## Verification plan

### Local smoke test (before PR merge)

1. Run migration locally against a dev DB seeded with fake `UserSession` rows
2. Confirm `RAISE NOTICE` prints expected row count
3. Confirm post-migration `SELECT COUNT(*) FROM "UserSession"` returns 0
4. Start dev server, log in, watch DevTools Network for `POST /api/activity/heartbeat 204` every 60s
5. After 2 minutes, query `SELECT * FROM "UserSession"` — expect 1 row with `lastHeartbeatAt` updated twice
6. Visit `/admin` Activity tab — expect 1 user, ~2 min duration, Active Today = 1

### Production deploy verification (T+0)

1. SSH to production, pull main, run `docker compose run --rm app npx prisma migrate deploy`
2. Confirm migration log shows the `RAISE NOTICE` row count
3. `docker compose up -d --build app` — restart with new code
4. SSH `psql`:
   ```sql
   SELECT COUNT(*) FROM "UserSession";  -- expect 0
   ```
5. Open `/admin` in a browser, log in
6. Open DevTools Network tab, watch for `POST /api/activity/heartbeat 204` every 60s
7. After 2 minutes, query:
   ```sql
   SELECT * FROM "UserSession" ORDER BY "loginAt" DESC LIMIT 5;
   ```
   Expect ≥1 row with realistic `lastHeartbeatAt`
8. Visit `/admin` Activity tab — expect Total Users = 5, Active Today ≥ 1 (you), per-user table starts populating

### T+24h verification

1. Per-user durations should be in realistic ranges (5–60 min for active users; never > 4 hours)
2. `Last Active` column reflects real recent times for users who visited
3. Sanity check: `SELECT MAX(duration) FROM "UserSession" WHERE duration IS NOT NULL` — expect < 4 hours (5-min idle close should prevent runaway durations)

---

## Rollback

Schema migration is purely additive. To roll back:

1. Revert the code commit
2. Redeploy previous version
3. The new columns (`lastSeenAt`, `lastHeartbeatAt`) stay in the database but are harmless (NULL on old code paths)
4. The wiped legacy data is **not** recoverable; this is acceptable because the data was contaminated and had no value

If a rollback is needed at the migration step (extremely unlikely — migration is additive), the schema additions can be reversed manually:

```sql
ALTER TABLE "User"        DROP COLUMN "lastSeenAt";
ALTER TABLE "UserSession" DROP COLUMN "lastHeartbeatAt";
DROP INDEX "UserSession_lastHeartbeatAt_idx";
```

---

## File manifest

### New files
- `src/app/api/activity/heartbeat/route.ts` — heartbeat endpoint (~50 lines)
- `src/components/ActivityHeartbeat.tsx` — client heartbeat component (~40 lines)
- `prisma/migrations/<timestamp>_user_activity_heartbeat/migration.sql` — schema + scoped wipe

### Modified files
- `prisma/schema.prisma` — add `User.lastSeenAt`, `UserSession.lastHeartbeatAt`, new index
- `src/app/api/admin/activity/route.ts` — replace per-user query with COALESCE-aware aggregate; replace `Active Today` query
- `src/app/layout.tsx` — mount `<ActivityHeartbeat />` once

### Not touched
- `src/app/admin/page.tsx` — markup is already correct
- `src/app/api/auth/route.ts` — login + logout flow unchanged
- `src/lib/auth.ts` — auth check unchanged
- All Council, Spike, Portfolio, Email code paths

---

## Open questions

None. Design is complete and locked-in pending user review of this document.
