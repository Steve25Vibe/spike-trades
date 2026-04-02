# Spike It Editable Entry Price Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users override the recorded entry price before a Spike It analysis runs, so the LLM recommendation reflects their real position.

**Architecture:** Single-file frontend change in `SpikeItModal.tsx`. Add local state for an editable entry price, a pencil icon toggle, and an inline input. When the user confirms a new price, re-run the analysis. No backend changes — the API already accepts any entry price.

**Tech Stack:** React, TypeScript, Tailwind CSS

---

### Task 1: Add editable entry price state and update fetch logic

**Files:**
- Modify: `src/components/portfolio/SpikeItModal.tsx`

- [ ] **Step 1: Add state variables and update fetchAnalysis**

In `SpikeItModal.tsx`, replace lines 120-146 (the component function signature through the end of `fetchAnalysis`):

```tsx
export default function SpikeItModal({ ticker, companyName, entryPrice, onClose }: Props) {
  const [result, setResult] = useState<SpikeItResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchAnalysis = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/portfolio/spike-it', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker, entryPrice }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data: SpikeItResult = await res.json();
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [ticker, entryPrice]);
```

with:

```tsx
export default function SpikeItModal({ ticker, companyName, entryPrice, onClose }: Props) {
  const [result, setResult] = useState<SpikeItResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeEntryPrice, setActiveEntryPrice] = useState(entryPrice);
  const [isEditingPrice, setIsEditingPrice] = useState(false);
  const [editInput, setEditInput] = useState(entryPrice.toFixed(2));

  const fetchAnalysis = useCallback(async (priceOverride?: number) => {
    const price = priceOverride ?? activeEntryPrice;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/portfolio/spike-it', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker, entryPrice: price }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data: SpikeItResult = await res.json();
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [ticker, activeEntryPrice]);
```

- [ ] **Step 2: Update the useEffect to pass entryPrice explicitly**

Replace lines 148-150:

```tsx
  useEffect(() => {
    fetchAnalysis();
  }, [fetchAnalysis]);
```

with:

```tsx
  useEffect(() => {
    fetchAnalysis(entryPrice);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

This ensures the initial fetch uses the prop value exactly once on mount, and doesn't re-trigger when `activeEntryPrice` changes (the user controls re-runs via the edit confirm action).

- [ ] **Step 3: Commit**

```bash
git add src/components/portfolio/SpikeItModal.tsx
git commit -m "refactor: add editable entry price state to SpikeItModal

Adds activeEntryPrice, isEditingPrice, and editInput state.
Updates fetchAnalysis to accept an optional price override.
No visible UI change yet — foundation for edit icon."
```

---

### Task 2: Add the entry price display with edit icon to the modal header

**Files:**
- Modify: `src/components/portfolio/SpikeItModal.tsx`

- [ ] **Step 1: Add the entry price row with edit toggle**

In the modal JSX, find the header section (lines 157-166):

```tsx
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-spike-text-dim">Live Health Check</div>
            <div className="text-xl font-bold text-spike-cyan">
              {ticker} <span className="text-sm font-normal text-spike-text-dim">{companyName}</span>
            </div>
          </div>
          <button onClick={onClose} className="text-spike-text-dim hover:text-spike-text text-xl leading-none">&times;</button>
        </div>
```

Replace it with:

```tsx
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-spike-text-dim">Live Health Check</div>
            <div className="text-xl font-bold text-spike-cyan">
              {ticker} <span className="text-sm font-normal text-spike-text-dim">{companyName}</span>
            </div>
          </div>
          <button onClick={onClose} className="text-spike-text-dim hover:text-spike-text text-xl leading-none">&times;</button>
        </div>

        {/* Editable Entry Price */}
        <div className="flex items-center gap-2 mb-4 text-sm">
          <span className="text-spike-text-dim">Entry:</span>
          {isEditingPrice ? (
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                const parsed = parseFloat(editInput);
                if (!isNaN(parsed) && parsed > 0) {
                  setActiveEntryPrice(parsed);
                  setIsEditingPrice(false);
                  fetchAnalysis(parsed);
                }
              }}
            >
              <span className="text-spike-text-dim">$</span>
              <input
                type="number"
                step="0.01"
                min="0.01"
                value={editInput}
                onChange={(e) => setEditInput(e.target.value)}
                autoFocus
                className="w-24 px-2 py-0.5 rounded bg-spike-bg border border-spike-cyan/30 text-spike-cyan font-mono text-sm focus:outline-none focus:border-spike-cyan"
              />
              <button
                type="submit"
                className="text-spike-green hover:text-spike-green/80 text-sm"
                title="Confirm"
              >
                &#10003;
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsEditingPrice(false);
                  setEditInput(activeEntryPrice.toFixed(2));
                }}
                className="text-spike-text-dim hover:text-spike-red text-sm"
                title="Cancel"
              >
                &#10005;
              </button>
            </form>
          ) : (
            <>
              <span className="text-spike-cyan font-mono font-semibold">${activeEntryPrice.toFixed(2)}</span>
              {activeEntryPrice !== entryPrice && (
                <span className="text-[9px] text-spike-text-dim">(edited)</span>
              )}
              <button
                onClick={() => {
                  setEditInput(activeEntryPrice.toFixed(2));
                  setIsEditingPrice(true);
                }}
                className="text-spike-text-dim hover:text-spike-cyan text-xs transition-colors"
                title="Edit entry price for this analysis"
                disabled={loading}
              >
                &#9998;
              </button>
            </>
          )}
        </div>
```

- [ ] **Step 2: Commit**

```bash
git add src/components/portfolio/SpikeItModal.tsx
git commit -m "feat: add editable entry price with pencil icon to Spike It modal

Users can click the pencil icon next to their entry price to override it.
Confirming re-runs the analysis with the new price. One-time only —
closing and reopening the modal resets to the recorded price."
```

---

### Task 3: Build verification + deploy

**Files:**
- No new files — verify existing changes compile and deploy

- [ ] **Step 1: TypeScript type check**

```bash
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" && npx tsc --noEmit
```

Expected: No errors (clean exit).

- [ ] **Step 2: Push to GitHub**

```bash
git push origin main
```

- [ ] **Step 3: Deploy to server (app container only — no Python changes)**

```bash
ssh -i ~/.ssh/digitalocean_saa root@147.182.150.30 \
  "cd /opt/spike-trades && git pull --rebase origin main && docker compose up -d --build app"
```

Expected: App container rebuilt and started.

- [ ] **Step 4: Visual verification**

Navigate to `https://spiketrades.ca/portfolio` in browser. On a position card:

1. Click **⚡ Spike It** → modal opens, entry price shown with pencil icon
2. Verify entry price matches the recorded position price
3. Click the **pencil icon** → input field appears with current price pre-filled
4. Type a different price (e.g., $5 lower) → click checkmark
5. Verify modal shows loading state and re-runs analysis
6. Verify result reflects the new entry price context
7. Close modal → reopen → verify price resets to original recorded price

- [ ] **Step 5: Commit plan doc**

```bash
git add docs/superpowers/plans/2026-04-02-spike-it-editable-entry-price.md
git commit -m "docs: editable entry price implementation plan"
```
