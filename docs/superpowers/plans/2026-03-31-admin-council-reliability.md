# Admin Council Panel — Reliability & Live Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the false "Offline" status on the Admin Council tab, add always-on polling while viewing the tab, and pull "Last Run" data from the database so it survives container restarts.

**Architecture:** Three targeted fixes to existing files — increase health check timeout with retry in the API route, add continuous polling in the React admin page, and replace in-memory last-run tracking with a database query.

**Tech Stack:** Next.js 15 (App Router), React, TypeScript, FastAPI (Python council), PostgreSQL via Prisma

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/app/api/admin/council/route.ts` | Modify | Health check retry logic, increased timeout, database-sourced last run |
| `src/app/admin/page.tsx` | Modify | Always-on polling, "Busy" status display, last run from recentReports |

---

### Task 1: Add Health Check Retry and Increased Timeout

**Files:**
- Modify: `src/app/api/admin/council/route.ts:19-27`

- [ ] **Step 1: Replace the single health check with a retry wrapper**

In `src/app/api/admin/council/route.ts`, replace lines 18-27:

```typescript
    // Fetch Python council health
    let councilHealth: Record<string, unknown> = {};
    try {
      const healthRes = await fetch(`${COUNCIL_API_URL}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      councilHealth = await healthRes.json();
    } catch {
      councilHealth = { status: 'unreachable', council_running: false };
    }
```

With:

```typescript
    // Fetch Python council health (with retry — council can be slow under LLM load)
    let councilHealth: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const healthRes = await fetch(`${COUNCIL_API_URL}/health`, {
          signal: AbortSignal.timeout(15000),
        });
        councilHealth = await healthRes.json();
        break; // Success — stop retrying
      } catch {
        if (attempt === 0) {
          await new Promise(r => setTimeout(r, 2000)); // Wait 2s before retry
        } else {
          councilHealth = { status: 'unreachable', council_running: false };
        }
      }
    }
```

- [ ] **Step 2: Also increase the FMP health timeout**

In the same file, find the FMP health fetch (around line 51) and change:

```typescript
        signal: AbortSignal.timeout(5000),
```

to:

```typescript
        signal: AbortSignal.timeout(10000),
```

- [ ] **Step 3: Verify the Python syntax check passes**

Run:
```bash
cd /Users/coeus/spiketrades.ca/claude-code && npx tsc --noEmit src/app/api/admin/council/route.ts 2>&1 | head -20
```

Expected: No type errors (or only pre-existing ones unrelated to this change).

- [ ] **Step 4: Commit**

```bash
git add src/app/api/admin/council/route.ts
git commit -m "fix: add retry + increase timeout for council health check

Health check now retries once after 2s delay before declaring unreachable.
Timeout increased from 5s to 15s — council can be slow during LLM batch
processing but is still healthy."
```

---

### Task 2: Always-On Polling While Council Tab Is Active

**Files:**
- Modify: `src/app/admin/page.tsx:101-175`

- [ ] **Step 1: Replace the polling logic with always-on behavior**

In `src/app/admin/page.tsx`, replace the `fetchCouncilStatus` and polling functions (lines 145-179):

```typescript
  const fetchCouncilStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/council');
      const json = await res.json();
      if (json.success) {
        setCouncil(json.data);
        // If running, ensure polling is active
        if (json.data.runInProgress && !pollRef.current) {
          startPolling();
        }
        // If no longer running, stop polling
        if (!json.data.runInProgress && pollRef.current) {
          stopPolling();
        }
      }
    } catch { /* silent */ }
  }, []);

  const startPolling = () => {
    if (pollRef.current) return;
    const startTime = Date.now();
    setElapsedTime(0);
    // Elapsed timer — tick every second
    timerRef.current = setInterval(() => {
      setElapsedTime(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);
    // Status poll — every 10 seconds
    pollRef.current = setInterval(() => {
      fetchCouncilStatus();
    }, 10000);
  };

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  };
```

With:

```typescript
  const fetchCouncilStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/council');
      const json = await res.json();
      if (json.success) {
        setCouncil(json.data);
        // Adjust poll speed based on run state
        const isRunning = json.data.runInProgress;
        const currentInterval = pollRef.current ? pollIntervalRef.current : 0;
        const targetInterval = isRunning ? 5000 : 15000;
        if (currentInterval !== targetInterval && pollRef.current) {
          // Switch poll speed
          clearInterval(pollRef.current);
          pollRef.current = setInterval(() => { fetchCouncilStatusRef.current(); }, targetInterval);
          pollIntervalRef.current = targetInterval;
        }
        // Start/stop elapsed timer based on run state
        if (isRunning && !timerRef.current) {
          const startTime = Date.now() - (json.data.runStatus?.elapsed_s ?? 0) * 1000;
          timerRef.current = setInterval(() => {
            setElapsedTime(Math.floor((Date.now() - startTime) / 1000));
          }, 1000);
        }
        if (!isRunning && timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
      }
    } catch { /* silent — will retry on next poll */ }
  }, []);

  // Stable ref for fetchCouncilStatus so setInterval always calls latest version
  const fetchCouncilStatusRef = useRef(fetchCouncilStatus);
  fetchCouncilStatusRef.current = fetchCouncilStatus;
  const pollIntervalRef = useRef(0);

  const startPolling = () => {
    if (pollRef.current) return;
    const interval = 15000; // Start at 15s, switches to 5s if run detected
    pollRef.current = setInterval(() => { fetchCouncilStatusRef.current(); }, interval);
    pollIntervalRef.current = interval;
  };

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; pollIntervalRef.current = 0; }
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  };
```

- [ ] **Step 2: Start polling whenever council tab is active**

Replace the `fetchData` council branch (around line 128-129):

```typescript
      } else if (tab === 'council') {
        await fetchCouncilStatus();
      }
```

With:

```typescript
      } else if (tab === 'council') {
        await fetchCouncilStatus();
        startPolling();
      }
```

- [ ] **Step 3: Stop polling when leaving the council tab**

In the `useEffect` that watches `tab` (lines 101-103), add cleanup before the fetch:

```typescript
  useEffect(() => {
    // Stop council polling when navigating away
    if (tab !== 'council') stopPolling();
    fetchData();
  }, [tab]);
```

- [ ] **Step 4: Verify TypeScript compiles**

Run:
```bash
cd /Users/coeus/spiketrades.ca/claude-code && npx tsc --noEmit 2>&1 | head -20
```

Expected: No new type errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/admin/page.tsx
git commit -m "feat: always-on polling for admin council tab

Polls every 15s while viewing, speeds up to 5s during active runs.
Polling starts on tab open, stops on tab switch or unmount.
Elapsed timer syncs with server-reported elapsed_s on first load."
```

---

### Task 3: "Busy" Status When Health Times Out During Active Run

**Files:**
- Modify: `src/app/admin/page.tsx:521-526`

- [ ] **Step 1: Update the Python Server status display**

Replace the status display (lines 521-526):

```typescript
              <div className="glass-card p-4 text-center">
                <p className="text-[9px] text-spike-text-muted uppercase tracking-wider mb-1">Python Server</p>
                <p className={cn('text-xl font-bold mono', council?.councilHealth?.status === 'ok' ? 'text-spike-green' : 'text-spike-red')}>
                  {council?.councilHealth?.status === 'ok' ? 'Online' : 'Offline'}
                </p>
              </div>
```

With:

```typescript
              <div className="glass-card p-4 text-center">
                <p className="text-[9px] text-spike-text-muted uppercase tracking-wider mb-1">Python Server</p>
                {(() => {
                  const status = council?.councilHealth?.status;
                  const isRunning = council?.runInProgress || council?.councilHealth?.council_running;
                  if (status === 'ok') return <p className="text-xl font-bold mono text-spike-green">Online</p>;
                  if (isRunning) return <p className="text-xl font-bold mono text-spike-amber">Busy</p>;
                  return <p className="text-xl font-bold mono text-spike-red">Offline</p>;
                })()}
              </div>
```

- [ ] **Step 2: Commit**

```bash
git add src/app/admin/page.tsx
git commit -m "fix: show 'Busy' instead of 'Offline' when council is running

When health check times out but a run is in progress, display amber
'Busy' status instead of red 'Offline'. True 'Offline' only shows
when no run is detected and health is unreachable."
```

---

### Task 4: Last Run Card From Database

**Files:**
- Modify: `src/app/admin/page.tsx:511-520`

- [ ] **Step 1: Update the Last Run card to use database data**

Replace the Last Run card (lines 511-520):

```typescript
              <div className="glass-card p-4 text-center">
                <p className="text-[9px] text-spike-text-muted uppercase tracking-wider mb-1">Last Run</p>
                <p className="text-xl font-bold text-spike-cyan mono">
                  {council?.latestLog?.processingTimeMs
                    ? formatDurationMs(council.latestLog.processingTimeMs)
                    : council?.councilHealth?.last_run_time
                      ? formatDuration(Math.round(council.councilHealth.last_run_time))
                      : '--'}
                </p>
              </div>
```

With:

```typescript
              <div className="glass-card p-4 text-center">
                <p className="text-[9px] text-spike-text-muted uppercase tracking-wider mb-1">Last Run</p>
                <p className="text-xl font-bold text-spike-cyan mono">
                  {council?.councilHealth?.last_run_time
                    ? formatDuration(Math.round(council.councilHealth.last_run_time))
                    : council?.latestLog?.processingTimeMs
                      ? formatDurationMs(council.latestLog.processingTimeMs)
                      : '--'}
                </p>
                {council?.recentReports?.[0] && (
                  <p className="text-[8px] text-spike-text-muted mt-1">
                    {new Date(council.recentReports[0].date).toLocaleDateString('en-CA')} · {council.recentReports[0].spikeCount} spikes
                  </p>
                )}
              </div>
```

This prioritizes the Python `last_run_time` (which is the most accurate — actual pipeline duration), falls back to the CouncilLog processing time, and adds a subtitle showing the date and spike count from the most recent database report.

- [ ] **Step 2: Commit**

```bash
git add src/app/admin/page.tsx
git commit -m "fix: last run card uses database data, survives restarts

Shows pipeline duration from council health + date/spike count from
most recent DailyReport in PostgreSQL. No longer relies on in-memory
state that resets on container restart."
```

---

### Task 5: Deploy and Verify

**Files:** None (deployment only)

- [ ] **Step 1: Push to GitHub**

```bash
git push origin main
```

- [ ] **Step 2: Pull and rebuild on server**

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 "cd /opt/spike-trades && git pull && docker compose up -d --build app"
```

Only the `app` container needs rebuild — the council and cron containers are unchanged.

- [ ] **Step 3: Verify health check works**

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 "curl -s http://localhost:3000/api/admin/council | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d[\"data\"][\"councilHealth\"][\"status\"])'"
```

Expected: `ok`

- [ ] **Step 4: Verify in browser**

1. Navigate to spiketrades.ca → Admin → Council tab
2. Confirm "Python Server" shows **Online** (green)
3. Confirm "Last Run" shows duration + date/spike count
4. Wait 15 seconds — status should auto-refresh (check network tab for `/api/admin/council` calls)
5. If a run is in progress, confirm poll interval is 5s and pipeline visualization updates

- [ ] **Step 5: Commit deployment checkpoint**

Update `SESSION_TRANSITIONS.md` with results.
