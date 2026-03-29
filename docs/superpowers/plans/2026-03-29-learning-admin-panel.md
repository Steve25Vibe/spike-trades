# Learning System Admin Panel & Analysis Page — Implementation Plan (Plans B + C)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the learning engine's state to the admin via a new "Learning" tab in the admin panel, and show per-pick learning adjustments on the analysis detail page so users understand why scores are what they are.

**Architecture:** New API endpoint `/api/admin/learning` reads learning state from the Python council container. New admin tab renders mechanism cards, current weights, and impact tracking. Analysis page gets a "Learning Adjustments" section below the score radar, reading from the `learningAdjustments` field stored per spike.

**Tech Stack:** Next.js 15, React, TypeScript, Tailwind CSS, existing glass-card design system

**Depends on:** Plan A (Learning Engine Core) must be deployed first — this plan reads data produced by Plan A's `LearningEngine.get_mechanism_states()` and per-pick `learning_adjustments` dict.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/app/api/admin/learning/route.ts` | Create | API: proxy to council container for learning state |
| `src/app/admin/page.tsx` | Modify | Add 6th "Learning" tab |
| `src/app/dashboard/analysis/[id]/page.tsx` | Modify | Add "Learning Adjustments" section |
| `src/app/api/spikes/[id]/route.ts` | Modify | Return learningAdjustments field |
| `api_server.py` | Modify | Add `/learning-state` endpoint to FastAPI |

---

## Plan B: Admin Panel "Learning System" Tab

### Task 1: Add /learning-state endpoint to Python FastAPI

**Files:**
- Modify: `api_server.py`

- [ ] **Step 1: Add the endpoint**

In `api_server.py`, after the existing `/health` endpoint, add:

```python
@app.get("/learning-state")
async def learning_state():
    """Return current learning mechanism states for admin panel."""
    try:
        from canadian_llm_council_brain import LearningEngine
        le = LearningEngine(db_path="/app/data/spike_trades_council.db")
        states = le.get_mechanism_states()
        weights = le.compute_stage_weights()
        return {
            "success": True,
            "mechanisms": states,
            "current_stage_weights": weights,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}
```

- [ ] **Step 2: Commit**

```bash
git add api_server.py
git commit -m "feat: add /learning-state endpoint to council FastAPI"
```

---

### Task 2: Create /api/admin/learning API route

**Files:**
- Create: `src/app/api/admin/learning/route.ts`

- [ ] **Step 1: Create the route**

```typescript
import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';

const COUNCIL_URL = process.env.COUNCIL_URL || 'http://council:8000';

export async function GET() {
  const user = await requireAdmin();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(`${COUNCIL_URL}/learning-state`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const data = await res.json();
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error('Learning state fetch error:', error);
    return NextResponse.json(
      { success: true, data: { success: false, error: 'Council server unreachable' } },
      { status: 200 }
    );
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/admin/learning/route.ts
git commit -m "feat: admin API route for learning system state"
```

---

### Task 3: Add Learning tab to admin page

**Files:**
- Modify: `src/app/admin/page.tsx`

- [ ] **Step 1: Add 'learning' to Tab type**

At line 7, change:

```typescript
// OLD:
type Tab = 'users' | 'invitations' | 'activity' | 'council' | 'analytics';
// NEW:
type Tab = 'users' | 'invitations' | 'activity' | 'council' | 'analytics' | 'learning';
```

- [ ] **Step 2: Add learning state and fetch logic**

After the existing state declarations (~line 62), add:

```typescript
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const [learning, setLearning] = useState<Record<string, any> | null>(null);
```

In `fetchData()`, add the learning tab case after the analytics case:

```typescript
} else if (tab === 'learning') {
  const res = await fetch('/api/admin/learning');
  const json = await res.json();
  if (json.success && json.data?.success) {
    setLearning(json.data);
  }
}
```

- [ ] **Step 3: Add Learning tab button**

In the tab button row (look for the existing tab buttons ~line 265), add after Analytics:

```tsx
<button
  onClick={() => setTab('learning')}
  className={cn(
    'px-4 py-2 text-sm font-medium rounded-lg transition-all whitespace-nowrap',
    tab === 'learning'
      ? 'bg-spike-cyan/20 text-spike-cyan border border-spike-cyan/30'
      : 'text-spike-text-dim hover:text-spike-text hover:bg-spike-bg'
  )}
>
  Learning
</button>
```

- [ ] **Step 4: Add Learning tab content**

After the analytics tab closing `)}` (~line 800), add the learning tab content:

```tsx
{/* Learning System Tab */}
{tab === 'learning' && (
  <div className="space-y-6">
    {loading ? (
      <p className="text-spike-text-muted">Loading learning system state...</p>
    ) : !learning ? (
      <p className="text-spike-text-muted">Learning system not available. Ensure council server is running.</p>
    ) : (
      <>
        {/* Section 1: Mechanism Dashboard */}
        <div className="glass-card p-6">
          <h3 className="text-sm font-bold text-spike-text-dim uppercase tracking-wider mb-4">
            Mechanism Activation Status
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {learning.mechanisms?.map((m: { name: string; active: boolean; progress: number | string; gate: number }, i: number) => (
              <div key={i} className={cn(
                'rounded-xl p-4 border',
                m.active
                  ? 'bg-spike-green/5 border-spike-green/30'
                  : 'bg-spike-bg/50 border-spike-border'
              )}>
                <div className="flex items-center gap-2 mb-2">
                  <span className={cn(
                    'w-2 h-2 rounded-full',
                    m.active ? 'bg-spike-green' : 'bg-spike-text-muted'
                  )} />
                  <span className={cn(
                    'text-xs font-bold uppercase',
                    m.active ? 'text-spike-green' : 'text-spike-text-muted'
                  )}>
                    {m.active ? 'Active' : 'Waiting'}
                  </span>
                </div>
                <p className="text-sm font-medium text-spike-text mb-2">{m.name}</p>
                {typeof m.progress === 'number' && m.gate > 0 ? (
                  <>
                    <div className="w-full h-1.5 bg-spike-bg rounded-full overflow-hidden mb-1">
                      <div
                        className={cn('h-full rounded-full transition-all', m.active ? 'bg-spike-green' : 'bg-spike-cyan')}
                        style={{ width: `${Math.min((m.progress / m.gate) * 100, 100)}%` }}
                      />
                    </div>
                    <p className="text-[10px] text-spike-text-muted mono">
                      {m.progress}/{m.gate} resolved picks
                    </p>
                  </>
                ) : (
                  <p className="text-[10px] text-spike-text-muted mono">
                    {typeof m.progress === 'string' ? m.progress : 'No gate required'}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Section 2: Current Stage Weights */}
        <div className="glass-card p-6">
          <h3 className="text-sm font-bold text-spike-text-dim uppercase tracking-wider mb-4">
            Current Stage Weights
          </h3>
          <p className="text-spike-text-dim text-xs mb-4">
            How much influence each LLM stage has on the final consensus score. Default: S1=15%, S2=20%, S3=30%, S4=35%.
          </p>
          <div className="grid grid-cols-4 gap-4">
            {Object.entries(learning.current_stage_weights || {}).map(([stage, weight]) => {
              const defaults: Record<string, number> = {'1': 0.15, '2': 0.20, '3': 0.30, '4': 0.35};
              const defaultW = defaults[stage] || 0.25;
              const w = weight as number;
              const delta = ((w - defaultW) * 100).toFixed(1);
              const deltaNum = parseFloat(delta);
              const stageNames: Record<string, string> = {'1': 'Sonnet', '2': 'Gemini', '3': 'Opus', '4': 'Grok'};
              return (
                <div key={stage} className="glass-card p-4 text-center">
                  <p className="text-[9px] text-spike-text-muted uppercase tracking-wider mb-1">
                    Stage {stage} ({stageNames[stage]})
                  </p>
                  <p className="text-xl font-bold text-spike-cyan mono">
                    {(w * 100).toFixed(1)}%
                  </p>
                  {deltaNum !== 0 && (
                    <p className={cn('text-xs mono', deltaNum > 0 ? 'text-spike-green' : 'text-spike-red')}>
                      {deltaNum > 0 ? '+' : ''}{delta}% vs default
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </>
    )}
  </div>
)}
```

- [ ] **Step 5: Commit**

```bash
git add src/app/admin/page.tsx
git commit -m "feat: admin panel Learning System tab with mechanism dashboard"
```

---

## Plan C: Analysis Page "Learning Adjustments" Section

### Task 4: Return learningAdjustments from spikes API

**Files:**
- Modify: `src/app/api/spikes/[id]/route.ts`

- [ ] **Step 1: Add learningAdjustments to the spike response**

In the spike detail response object (~line 134, after the `technicals` block), add:

```typescript
// Learning adjustments (if available)
learningAdjustments: spike.learningAdjustments ? JSON.parse(spike.learningAdjustments as string) : null,
```

Note: This depends on Plan A Task 12 having stored `learningAdjustments` as a JSON string in the Spike model. If the Prisma schema doesn't have this field yet, it needs to be added:

```prisma
// In prisma/schema.prisma, Spike model:
learningAdjustments String?  // JSON blob of learning engine adjustments
```

Then run `npx prisma db push` on the server.

- [ ] **Step 2: Commit**

```bash
git add src/app/api/spikes/[id]/route.ts
git commit -m "feat: return learningAdjustments in spike detail API"
```

---

### Task 5: Add Learning Adjustments section to analysis page

**Files:**
- Modify: `src/app/dashboard/analysis/[id]/page.tsx`

- [ ] **Step 1: Add the section after the score breakdown radar chart**

Find the score breakdown radar chart section (ends ~line 420). After its closing `</div>`, add:

```tsx
{/* ===== LEARNING ADJUSTMENTS ===== */}
{data.learningAdjustments && (
  <div className="glass-card p-6 mb-6">
    <h3 className="text-sm font-bold text-spike-text-dim uppercase tracking-wider mb-4">
      Learning Adjustments
    </h3>
    <p className="text-spike-text-dim text-xs mb-4">
      How the self-improving learning system adjusted this pick&apos;s score based on historical accuracy data.
    </p>
    <div className="space-y-3">
      {(() => {
        const adj = data.learningAdjustments;
        const items = [
          {
            label: 'Stage Weights',
            value: adj.stage_weights
              ? `S1=${(adj.stage_weights['1'] * 100).toFixed(0)}% S2=${(adj.stage_weights['2'] * 100).toFixed(0)}% S3=${(adj.stage_weights['3'] * 100).toFixed(0)}% S4=${(adj.stage_weights['4'] * 100).toFixed(0)}%`
              : 'Default (15/20/30/35)',
            neutral: !adj.stage_weights || JSON.stringify(adj.stage_weights) === JSON.stringify({1: 0.15, 2: 0.20, 3: 0.30, 4: 0.35}),
          },
          {
            label: 'Sector Multiplier',
            value: adj.sector_multiplier ? `${(adj.sector_multiplier * 100).toFixed(1)}%` : '100%',
            neutral: !adj.sector_multiplier || Math.abs(adj.sector_multiplier - 1.0) < 0.01,
            positive: adj.sector_multiplier > 1.0,
          },
          {
            label: 'Earnings Proximity',
            value: adj.earnings_penalty ? `${(adj.earnings_penalty * 100).toFixed(0)}%` : 'No penalty',
            neutral: !adj.earnings_penalty || adj.earnings_penalty >= 0.99,
            positive: false,
          },
          {
            label: 'Insider Signal',
            value: adj.insider_adj ? `${(adj.insider_adj * 100).toFixed(1)}%` : '100%',
            neutral: !adj.insider_adj || Math.abs(adj.insider_adj - 1.0) < 0.01,
            positive: adj.insider_adj > 1.0,
          },
          {
            label: 'Analyst Consensus',
            value: adj.analyst_adj ? `${(adj.analyst_adj * 100).toFixed(1)}%` : '100%',
            neutral: !adj.analyst_adj || Math.abs(adj.analyst_adj - 1.0) < 0.01,
            positive: adj.analyst_adj > 1.0,
          },
          {
            label: 'Sector Relative Strength',
            value: adj.srs_adj ? `${(adj.srs_adj * 100).toFixed(1)}%` : '100%',
            neutral: !adj.srs_adj || Math.abs(adj.srs_adj - 1.0) < 0.01,
            positive: adj.srs_adj > 1.0,
          },
          {
            label: 'Stage Disagreement',
            value: adj.disagreement_adj ? `${(adj.disagreement_adj * 100).toFixed(1)}%` : 'No disagreement',
            neutral: !adj.disagreement_adj || Math.abs(adj.disagreement_adj - 1.0) < 0.01,
            positive: adj.disagreement_adj > 1.0,
          },
          {
            label: 'IV Reality Check',
            value: adj.iv_check ? `${(adj.iv_check * 100).toFixed(0)}%` : 'No IV data',
            neutral: !adj.iv_check || Math.abs(adj.iv_check - 1.0) < 0.01,
            positive: adj.iv_check > 1.0,
          },
        ].filter(item => !item.neutral); // Only show adjustments that actually changed something

        if (items.length === 0) {
          return (
            <p className="text-spike-text-muted text-sm">
              No learning adjustments applied to this pick (all mechanisms at default values).
            </p>
          );
        }

        return items.map((item) => (
          <div key={item.label} className="flex items-center justify-between py-2 border-b border-spike-border/30">
            <span className="text-sm text-spike-text-dim">{item.label}</span>
            <span className={cn(
              'text-sm font-bold mono',
              item.positive ? 'text-spike-green' : 'text-spike-red'
            )}>
              {item.value}
            </span>
          </div>
        ));
      })()}
    </div>
    {data.learningAdjustments.conviction_thresholds && (
      <p className="text-[10px] text-spike-text-muted mt-3">
        Conviction thresholds: HIGH &ge; {data.learningAdjustments.conviction_thresholds[0]}, MEDIUM &ge; {data.learningAdjustments.conviction_thresholds[1]}
      </p>
    )}
  </div>
)}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/dashboard/analysis/[id]/page.tsx
git commit -m "feat: learning adjustments section on analysis detail page"
```

---

### Task 6: Add Prisma field, compile check, and deploy

- [ ] **Step 1: Add learningAdjustments to Prisma schema**

In `prisma/schema.prisma`, in the Spike model, add:

```prisma
learningAdjustments String?  // JSON blob of per-pick learning adjustments
```

- [ ] **Step 2: TypeScript compile check**

```bash
npx tsc --noEmit
```

Expected: 0 errors

- [ ] **Step 3: Version bump to Ver 3.0**

Update version string in all page footers (login, dashboard, analysis, portfolio, accuracy, reports, settings, admin) from current version to `Ver 3.0`.

- [ ] **Step 4: Commit and push**

```bash
git add -A
git commit -m "feat: learning system admin tab + analysis adjustments + Ver 3.0"
git push origin main
```

- [ ] **Step 5: Deploy to server**

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 \
  "cd /opt/spike-trades && git pull && \
   docker compose up -d --build app council && \
   docker exec spike-trades-app node /app/node_modules/prisma/build/index.js db push --skip-generate"
```

- [ ] **Step 6: Verify admin Learning tab**

Navigate to spiketrades.ca/admin → Learning tab. Should see:
- 8 mechanism cards with Active/Waiting status and progress bars
- Current stage weights (defaults until gate met)

- [ ] **Step 7: Commit deployment verification**

```bash
git add SESSION_TRANSITIONS.md
git commit -m "docs: learning admin panel and analysis adjustments deployed as Ver 3.0"
```

---

## Dependency Order

```
Plan A (Learning Engine Core) must be deployed first
  ↓
Task 1 (FastAPI endpoint) → no Plan B/C dependencies
Task 2 (TS API route) → depends on Task 1
Task 3 (Admin tab UI) → depends on Task 2
Task 4 (Spikes API field) → depends on Plan A Task 12
Task 5 (Analysis section) → depends on Task 4
Task 6 (Schema + deploy) → depends on all tasks
```

Tasks 1-3 (Plan B) and Tasks 4-5 (Plan C) are independent of each other.
