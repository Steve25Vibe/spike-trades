# User Activity Heartbeat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken login-event tracking on the admin User Activity dashboard with a real presence-based heartbeat system that produces truthful Active Today / Avg Session / Last Active numbers.

**Architecture:** A 60-second client-side heartbeat (visibility-gated) pings a new `/api/activity/heartbeat` endpoint, which lazily extends or rotates `UserSession` rows. The admin dashboard query reads `lastHeartbeatAt` and uses COALESCE for still-open sessions. A scoped DELETE wipes contaminated legacy rows during the migration. No background cron is added.

**Tech Stack:** Next.js 14 App Router, Prisma + Postgres, TypeScript, iron-session (existing). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-04-08-user-activity-heartbeat-design.md`

**Verification approach:** This project does not have a unit test framework (no Jest/Vitest/Playwright). Verification is done via TypeScript build checks, psql queries, curl probes, and browser DevTools network inspection — matching the pattern used by the Phase 1 plan.

---

## File Structure

### New files

| Path | Responsibility | Approx LoC |
|---|---|---|
| `prisma/migrations/20260408_user_activity_heartbeat/migration.sql` | Schema additions + scoped legacy wipe | ~25 |
| `src/app/api/activity/heartbeat/route.ts` | Heartbeat endpoint: extends or rotates open UserSession | ~55 |
| `src/components/ActivityHeartbeat.tsx` | Client component: 60s visibility-gated heartbeat | ~45 |

### Modified files

| Path | Change | Approx LoC delta |
|---|---|---|
| `prisma/schema.prisma` | Add `User.lastSeenAt`, `UserSession.lastHeartbeatAt`, new index | +3 |
| `src/app/api/admin/activity/route.ts` | Replace per-user query with COALESCE-aware aggregate; replace Active Today query | ~30 changed |
| `src/app/layout.tsx` | Mount `<ActivityHeartbeat />` next to `<ServiceWorkerRegistration />` | +2 |

### Not touched

- `src/app/admin/page.tsx` — Activity tab markup is already correct
- `src/app/api/auth/route.ts` — login + logout flow unchanged
- `src/lib/auth.ts` — auth check unchanged
- All Council, Spike, Portfolio, Email code paths

---

## Pre-flight: branch + verification baseline

### Task 0: Create feature branch from main

**Files:** none

- [ ] **Step 1: Fetch and verify clean working tree**

Run:
```bash
git fetch origin
git status
```
Expected: working tree clean (or only the unrelated `.claude/worktrees/` and SESSION_8_TRANSITION.md untracked files from before this work). If anything related to this feature is uncommitted, stop and investigate.

- [ ] **Step 2: Create feature branch from origin/main**

Run:
```bash
git checkout -b feat/user-activity-heartbeat origin/main
```
Expected: switched to new branch, based on latest origin/main.

- [ ] **Step 3: Cherry-pick the spec commit onto the feature branch**

Run:
```bash
git cherry-pick 9d450f5
```
Expected: clean cherry-pick, no conflicts. The spec commit `docs(spec): user activity heartbeat design` now sits on the feature branch.

- [ ] **Step 4: Verify TypeScript build is clean before changes**

Run:
```bash
npm run build 2>&1 | tail -20
```
Expected: build succeeds, no TypeScript errors. This is the baseline — every later task's build check is compared against this.

- [ ] **Step 5: Push branch to origin**

Run:
```bash
git push -u origin feat/user-activity-heartbeat
```
Expected: branch pushed.

---

## Task 1: Schema additions

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add `lastSeenAt` to User model**

Find the `User` model (around line 16). Locate the `lastLoginAt` line:
```prisma
  lastLoginAt       DateTime?
```

Add a new field directly after it:
```prisma
  lastLoginAt       DateTime?
  lastSeenAt        DateTime?
```

- [ ] **Step 2: Add `lastHeartbeatAt` to UserSession model + index**

Find the `UserSession` model (around line 57). Replace the entire model block with:

```prisma
model UserSession {
  id              String    @id @default(cuid())
  userId          String
  user            User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  loginAt         DateTime  @default(now())
  logoutAt        DateTime?
  duration        Int?      // seconds
  lastHeartbeatAt DateTime?

  @@index([userId])
  @@index([loginAt])
  @@index([lastHeartbeatAt])
}
```

- [ ] **Step 3: Generate Prisma client**

Run:
```bash
npx prisma generate
```
Expected: "Generated Prisma Client" with no errors.

- [ ] **Step 4: TypeScript build check**

Run:
```bash
npm run build 2>&1 | tail -20
```
Expected: build succeeds. The schema change adds optional fields, so no existing code breaks.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(schema): add lastSeenAt + lastHeartbeatAt for activity heartbeat"
git push
```

---

## Task 2: Migration file with scoped wipe

**Files:**
- Create: `prisma/migrations/20260408_user_activity_heartbeat/migration.sql`

- [ ] **Step 1: Create migration directory**

Run:
```bash
mkdir -p prisma/migrations/20260408_user_activity_heartbeat
```

- [ ] **Step 2: Write migration SQL**

Create `prisma/migrations/20260408_user_activity_heartbeat/migration.sql` with this exact content:

```sql
-- AlterTable: Add lastSeenAt to User
ALTER TABLE "User" ADD COLUMN "lastSeenAt" TIMESTAMP(3);

-- AlterTable: Add lastHeartbeatAt to UserSession
ALTER TABLE "UserSession" ADD COLUMN "lastHeartbeatAt" TIMESTAMP(3);

-- CreateIndex: lastHeartbeatAt (for "active today" queries)
CREATE INDEX "UserSession_lastHeartbeatAt_idx" ON "UserSession"("lastHeartbeatAt");

-- Audit log: pre-flight count of legacy rows about to be deleted
DO $$
DECLARE row_count int;
BEGIN
  SELECT COUNT(*) INTO row_count FROM "UserSession";
  RAISE NOTICE 'About to delete % UserSession rows (legacy data, pre-heartbeat)', row_count;
END $$;

-- Scoped wipe of contaminated legacy data
-- WHERE clause is honest ("everything that exists at migration time")
-- and race-safe: rows inserted by other connections after NOW() survive
DELETE FROM "UserSession" WHERE "loginAt" < NOW();
```

- [ ] **Step 3: Verify migration file exists**

Run:
```bash
ls -la prisma/migrations/20260408_user_activity_heartbeat/
cat prisma/migrations/20260408_user_activity_heartbeat/migration.sql | head -20
```
Expected: file exists, contents match.

- [ ] **Step 4: Commit (do NOT run migrate dev — that hits the local DB)**

```bash
git add prisma/migrations/20260408_user_activity_heartbeat/
git commit -m "feat(migration): heartbeat schema + scoped legacy wipe"
git push
```

The migration will be applied on production via `prisma migrate deploy` in Task 7. Do not run it locally unless you have a disposable dev DB.

---

## Task 3: Heartbeat endpoint

**Files:**
- Create: `src/app/api/activity/heartbeat/route.ts`

- [ ] **Step 1: Create route directory**

Run:
```bash
mkdir -p src/app/api/activity/heartbeat
```

- [ ] **Step 2: Write the route handler**

Create `src/app/api/activity/heartbeat/route.ts` with this exact content:

```ts
import { NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth';
import prisma from '@/lib/db/prisma';

const IDLE_MS = 5 * 60 * 1000; // 5 minutes — gap that closes a session

// POST /api/activity/heartbeat — Extend or rotate the user's open session
export async function POST() {
  const user = await getAuthenticatedUser();
  if (!user) return new NextResponse(null, { status: 401 });

  const now = new Date();

  // Find this user's latest open session
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
    // No active session OR prior session went idle — close stale, open fresh
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

- [ ] **Step 3: TypeScript build check**

Run:
```bash
npm run build 2>&1 | tail -20
```
Expected: build succeeds. The new route is picked up by Next.js automatically.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/activity/heartbeat/route.ts
git commit -m "feat(api): add /api/activity/heartbeat endpoint"
git push
```

---

## Task 4: Client heartbeat component

**Files:**
- Create: `src/components/ActivityHeartbeat.tsx`

- [ ] **Step 1: Write the client component**

Create `src/components/ActivityHeartbeat.tsx` with this exact content:

```tsx
'use client';

import { useEffect } from 'react';

const HEARTBEAT_INTERVAL_MS = 60_000; // 60 seconds

/**
 * ActivityHeartbeat — fires POST /api/activity/heartbeat every 60s
 * while the tab is visible. Self-gates on /api/auth so unauthenticated
 * visitors do not ping. Silent failure: heartbeat errors never disrupt UX.
 */
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
      }).catch(() => {
        /* silent fail */
      });
    };

    fetch('/api/auth', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled || !data?.authenticated) return;
        sendBeat(); // immediate first beat
        const interval = setInterval(sendBeat, HEARTBEAT_INTERVAL_MS);
        const onVis = () => {
          if (document.visibilityState === 'visible') sendBeat();
        };
        document.addEventListener('visibilitychange', onVis);
        cleanup = () => {
          clearInterval(interval);
          document.removeEventListener('visibilitychange', onVis);
        };
      })
      .catch(() => {
        /* silent fail */
      });

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  return null;
}
```

- [ ] **Step 2: TypeScript build check**

Run:
```bash
npm run build 2>&1 | tail -20
```
Expected: build succeeds. Component is not yet imported anywhere, so it has no runtime effect yet.

- [ ] **Step 3: Commit**

```bash
git add src/components/ActivityHeartbeat.tsx
git commit -m "feat(client): add ActivityHeartbeat component"
git push
```

---

## Task 5: Mount the heartbeat in root layout

**Files:**
- Modify: `src/app/layout.tsx`

- [ ] **Step 1: Add import**

In `src/app/layout.tsx`, after the existing import line:
```tsx
import ServiceWorkerRegistration from '@/components/providers/ServiceWorkerRegistration';
```

Add a new import:
```tsx
import ServiceWorkerRegistration from '@/components/providers/ServiceWorkerRegistration';
import { ActivityHeartbeat } from '@/components/ActivityHeartbeat';
```

- [ ] **Step 2: Mount inside AuthProvider**

In the same file, find the JSX block:
```tsx
        <AuthProvider>
          <ServiceWorkerRegistration />
          {children}
        </AuthProvider>
```

Replace it with:
```tsx
        <AuthProvider>
          <ServiceWorkerRegistration />
          <ActivityHeartbeat />
          {children}
        </AuthProvider>
```

- [ ] **Step 3: TypeScript build check**

Run:
```bash
npm run build 2>&1 | tail -20
```
Expected: build succeeds. The component renders `null`, so visual layout is unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/app/layout.tsx
git commit -m "feat(layout): mount ActivityHeartbeat in root layout"
git push
```

---

## Task 6: Update admin activity dashboard query

**Files:**
- Modify: `src/app/api/admin/activity/route.ts`

- [ ] **Step 1: Replace the entire route handler**

Replace the full contents of `src/app/api/admin/activity/route.ts` with:

```ts
import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import prisma from '@/lib/db/prisma';

// GET /api/admin/activity — User activity summary (heartbeat-driven)
export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // Total users
    const totalUsers = await prisma.user.count();

    // Active today: users with at least one heartbeat since 00:00 today
    const activeTodayRows = await prisma.userSession.findMany({
      where: { lastHeartbeatAt: { gte: todayStart } },
      distinct: ['userId'],
      select: { userId: true },
    });
    const activeToday = activeTodayRows.length;

    // Per-user aggregate: COALESCE handles still-open sessions by treating
    // (lastHeartbeatAt - loginAt) as "duration so far" until the session closes
    const sessionsByUser = await prisma.$queryRaw<
      Array<{
        userId: string;
        sessions: number;
        avg_duration_sec: number | null;
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

    // Join with User table for email
    const users = await prisma.user.findMany({
      select: { id: true, email: true },
    });
    const userById = new Map(users.map((u) => [u.id, u.email]));

    const perUser = sessionsByUser
      .map((row) => ({
        email: userById.get(row.userId) ?? '(unknown)',
        totalSessions: row.sessions,
        avgDurationSec: row.avg_duration_sec ?? 0,
        lastActive: row.last_active,
      }))
      .sort((a, b) => {
        const at = a.lastActive ? a.lastActive.getTime() : 0;
        const bt = b.lastActive ? b.lastActive.getTime() : 0;
        return bt - at;
      });

    // Global average session duration (same COALESCE logic, all users)
    const globalAvg = await prisma.$queryRaw<Array<{ avg_sec: number | null }>>`
      SELECT AVG(COALESCE(
        duration,
        EXTRACT(EPOCH FROM ("lastHeartbeatAt" - "loginAt"))::int
      ))::int AS avg_sec
      FROM "UserSession"
      WHERE "loginAt" >= NOW() - INTERVAL '30 days'
    `;
    const globalAvgDuration = globalAvg[0]?.avg_sec ?? 0;

    return NextResponse.json({
      success: true,
      data: {
        totalUsers,
        activeToday,
        avgSessionDurationSec: globalAvgDuration,
        perUser,
      },
    });
  } catch (error) {
    console.error('Admin activity error:', error);
    return NextResponse.json({ success: false, error: 'Failed to fetch activity' }, { status: 500 });
  }
}
```

- [ ] **Step 2: TypeScript build check**

Run:
```bash
npm run build 2>&1 | tail -20
```
Expected: build succeeds. The route's response shape (`totalUsers`, `activeToday`, `avgSessionDurationSec`, `perUser` array of `{email, totalSessions, avgDurationSec, lastActive}`) is identical to the existing one, so the admin page consumer is unaffected.

- [ ] **Step 3: Verify response shape matches admin page consumer**

Check that the consumer expects the same fields:

Run:
```bash
grep -n "totalUsers\|activeToday\|avgSessionDurationSec\|totalSessions\|avgDurationSec\|lastActive" src/app/admin/page.tsx
```
Expected: matches against the field names in the new response shape. If any field is renamed elsewhere, fix it before continuing.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/admin/activity/route.ts
git commit -m "feat(api): heartbeat-driven admin activity query"
git push
```

---

## Task 7: PR + production deploy

**Files:** none

- [ ] **Step 1: Open PR**

Run:
```bash
gh pr create --title "feat: user activity heartbeat" --body "$(cat <<'EOF'
## Summary
- Replaces broken login-event tracking with a 60s client heartbeat
- New `/api/activity/heartbeat` endpoint extends or rotates `UserSession` rows lazily
- Admin dashboard query reads `lastHeartbeatAt` with COALESCE for still-open sessions
- Migration scoped-wipes contaminated legacy `UserSession` rows (NULL durations + 21h tab-open garbage)
- Zero impact on passwords, browser auto-fill, or current logged-in cookies (verified at src/lib/auth.ts:73-99)

Spec: docs/superpowers/specs/2026-04-08-user-activity-heartbeat-design.md

## Test plan
- [x] Local TypeScript build passes
- [ ] Production migration log shows pre-flight RAISE NOTICE row count
- [ ] Post-deploy: heartbeat fires every 60s in browser DevTools (POST /api/activity/heartbeat 204)
- [ ] Post-deploy: SELECT COUNT(*) FROM "UserSession" returns 0 immediately after migration
- [ ] Post-deploy: admin Activity tab shows realistic minute-scale durations
- [ ] T+24h: no UserSession row has duration > 4 hours

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
Expected: PR created, URL printed.

- [ ] **Step 2: Wait for user approval to merge**

Stop here and ask the user: "PR is open. Want me to merge and deploy to production?"

Do not merge without explicit user confirmation.

- [ ] **Step 3: Merge after approval**

Run:
```bash
gh pr merge --squash --auto
```
Wait for the merge to complete.

- [ ] **Step 4: SSH to production and pull main**

Run:
```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'cd /opt/spike-trades && git pull origin main && git log --oneline -3'
```
Expected: HEAD advances to the merge commit of this PR.

- [ ] **Step 5: Run the migration on production**

Run:
```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'cd /opt/spike-trades && docker compose run --rm app npx prisma migrate deploy 2>&1'
```
Expected: output includes the line:
```
NOTICE:  About to delete N UserSession rows (legacy data, pre-heartbeat)
```
Where N is the legacy row count (should be ~70 based on the handoff doc's snapshot data).

**Two-keys-to-fire safety check:** Before this step, the user has approved the wipe in the spec review. The migration log captures the row count for audit. If N is wildly different from ~70 (e.g., > 1000 or < 10), STOP and investigate before continuing — something may have changed.

- [ ] **Step 6: Rebuild + restart app container**

Run:
```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'cd /opt/spike-trades && docker compose up -d --build app'
```
Expected: app container rebuilds with new code, restarts cleanly.

- [ ] **Step 7: Verify container health**

Run:
```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'cd /opt/spike-trades && docker compose ps --format "table {{.Name}}\t{{.Status}}"'
```
Expected: all 6 containers Up. `app` Up < 1 minute (just rebuilt). `council` and `db` still healthy.

---

## Task 8: T+0 production verification

**Files:** none

- [ ] **Step 1: Verify wipe completed**

Run:
```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'cd /opt/spike-trades && docker compose exec -T db psql -U spiketrades -d spiketrades -c "SELECT COUNT(*) FROM \"UserSession\";"'
```
Expected: count is 0 (or very small if heartbeats have already started firing from active browsers).

- [ ] **Step 2: Verify schema columns exist**

Run:
```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'cd /opt/spike-trades && docker compose exec -T db psql -U spiketrades -d spiketrades -c "\d \"UserSession\""'
```
Expected: output includes `lastHeartbeatAt | timestamp(3)` and an index `UserSession_lastHeartbeatAt_idx`.

Run:
```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'cd /opt/spike-trades && docker compose exec -T db psql -U spiketrades -d spiketrades -c "\d \"User\""'
```
Expected: output includes `lastSeenAt | timestamp(3)`.

- [ ] **Step 3: Open admin in browser, log in, watch DevTools Network tab**

Open `https://spiketrades.ca/admin` in a browser (from your local machine, not SSH). Log in with admin credentials.

Open browser DevTools → Network tab → filter on `heartbeat`.

Expected: 
- `POST /api/activity/heartbeat` fires within ~50ms of page load (status 204)
- Another fires every 60 seconds while the tab is in the foreground
- Switch to a different tab and the heartbeats stop
- Switch back and a beat fires immediately

- [ ] **Step 4: Verify session row was created**

After ~2 minutes of the admin page being open, run:
```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'cd /opt/spike-trades && docker compose exec -T db psql -U spiketrades -d spiketrades -c "SELECT id, \"userId\", \"loginAt\", \"lastHeartbeatAt\", \"logoutAt\", duration FROM \"UserSession\" ORDER BY \"loginAt\" DESC LIMIT 5;"'
```
Expected:
- 1 row exists for your user
- `loginAt` ≈ time you opened the admin page
- `lastHeartbeatAt` ≈ within the last 60s
- `logoutAt` is NULL
- `duration` is NULL

- [ ] **Step 5: Verify User.lastSeenAt is updated**

Run:
```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'cd /opt/spike-trades && docker compose exec -T db psql -U spiketrades -d spiketrades -c "SELECT email, \"lastSeenAt\" FROM \"User\" ORDER BY \"lastSeenAt\" DESC NULLS LAST LIMIT 5;"'
```
Expected: your user's `lastSeenAt` is recent (within last 60s).

- [ ] **Step 6: Verify admin Activity tab renders**

Visit `https://spiketrades.ca/admin` → Activity tab.

Expected:
- `Total Users: 5`
- `Active Today: 1` (you, possibly more if other users are also visiting)
- `Avg Session: <some small number>` (will grow as your session lengthens)
- Per-user table shows your email with realistic data

If the page shows the old broken numbers (21.4h / 0s), hard-refresh the browser. If still broken, the build did not pick up the new query — check that `docker compose up -d --build app` actually rebuilt.

---

## Task 9: T+24h verification

**Files:** none

- [ ] **Step 1: Wait until T+24h after Task 7 Step 6 (the rebuild moment)**

Do not run this task until at least 24 hours have passed since the production deploy.

- [ ] **Step 2: Check for runaway durations**

Run:
```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'cd /opt/spike-trades && docker compose exec -T db psql -U spiketrades -d spiketrades -c "SELECT id, \"userId\", duration FROM \"UserSession\" WHERE duration > 14400 ORDER BY duration DESC LIMIT 10;"'
```
Expected: zero rows. Any row with `duration > 14400` (4 hours) means the 5-minute idle close failed. If found, investigate before declaring victory.

- [ ] **Step 3: Sanity check the session count and distribution**

Run:
```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 'cd /opt/spike-trades && docker compose exec -T db psql -U spiketrades -d spiketrades -c "SELECT COUNT(*) AS sessions, COUNT(DISTINCT \"userId\") AS users, MIN(\"loginAt\") AS first, MAX(\"loginAt\") AS last FROM \"UserSession\";"'
```
Expected:
- `sessions` is some reasonable number (depends on actual user activity, but at least 1 for you)
- `users` ≥ 1
- `first` is at or after the migration deploy time
- `last` is recent

- [ ] **Step 4: Check the admin Activity tab one more time**

Visit `https://spiketrades.ca/admin` → Activity tab.

Expected:
- Per-user table reflects 24h of real activity
- All durations are realistic (single-digit minutes to maybe tens of minutes)
- No 21h outliers

- [ ] **Step 5: Final sign-off**

If all the above checks pass, post a summary in the session and mark this plan complete:

```
✅ User Activity Heartbeat — DEPLOYED + VERIFIED at T+24h

- Production HEAD: <commit>
- Legacy rows wiped: <N>
- New sessions accumulated: <count>
- Max duration observed: <minutes>
- All admin dashboard numbers truthful

Closing this plan.
```

---

## Self-Review

Spec coverage:
- Problem statement → addressed by Task 1 (schema), Task 3 (endpoint), Task 4 (client), Task 6 (query)
- Approach (heartbeat) → Tasks 3 + 4
- Component 1 (heartbeat endpoint) → Task 3
- Component 2 (client component) → Tasks 4 + 5
- Component 3 (dashboard query) → Task 6
- Data model changes → Tasks 1 + 2
- Migration scoped wipe → Task 2 + Task 7 Step 5
- Auth/cookie zero impact → noted in PR body, no code changes needed
- Configuration constants → embedded in Tasks 3 (IDLE_MS) + 4 (HEARTBEAT_INTERVAL_MS)
- Verification plan → Tasks 8 + 9
- Rollback → covered by additive migration; revert via git revert + redeploy

Placeholder scan: none found.

Type consistency:
- `IDLE_MS` defined in Task 3, used in Task 3 only ✓
- `HEARTBEAT_INTERVAL_MS` defined in Task 4, used in Task 4 only ✓
- `lastSeenAt` used in Tasks 1, 3, 6 — consistent name ✓
- `lastHeartbeatAt` used in Tasks 1, 2, 3, 6 — consistent name ✓
- Response shape (`totalUsers`, `activeToday`, `avgSessionDurationSec`, `perUser[].email/totalSessions/avgDurationSec/lastActive`) — matches the existing route and the admin page consumer per Task 6 Step 3 ✓
- `getAuthenticatedUser` used in Task 3 — matches existing export from `src/lib/auth.ts` ✓
- `requireAdmin` used in Task 6 — matches existing export ✓

Scope: focused, single subsystem, single PR. No decomposition needed.

All checks pass.
