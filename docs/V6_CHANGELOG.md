# v6.0 — 2026-04-09

Major release covering Phase 1 (legacy feature removal), Learning Engine
conservative bypass, Sibling A polish, Sibling B parallel council refactor,
and operational hardening.

Tag: `v6.0`
Production HEAD at cut: `ad62da4` (PR #16 hotfix)
Previous tag: `v5.0a` → `95c2366` (2026-04-07)
Commit count since v5.0a: 38 non-merge commits across 17 PRs

---

## Phase 1 — Radar + Opening Bell Removal

Surgical removal of two pre-Phase-1 features (Smart Money Flow Radar and
Opening Bell) that had been queued for replacement but were ultimately
deprecated. All scoring, scheduling, UI, settings, admin, and Python
pipeline references were excised in 10 sequential subtasks. Zero parity
drift confirmed via DB row-count baseline. Phase 1 was formally ACCEPTED
2026-04-08 at T+18.5h with early sign-off.

- chore(phase1/01): delete Radar + OB test files (2379fd4)
- chore(phase1/02): strip Radar + Opening Bell cron entries (b5932fc)
- feat(phase1/03): remove Radar + OB user-facing UI (1a941c4)
- feat(phase1/04): strip Radar + OB preferences from settings + API (513f131)
- feat(phase1/05): strip Radar + OB from admin panel (6247dc1)
- fix(phase1/05): drop dead body variable + unused request param (183f07f)
- feat(phase1/06): SpikeCard surgical exception + Spike type cleanup (5c17e76)
- feat(phase1/07): strip cross-refs in shared backend routes (0ba3542)
- feat(phase1/08): bulk delete leaf components, routes, libs (1e2f4a2)
- chore(phase1/09): strip Radar tailwind color + animation tokens (f0ce15a)
- feat(phase1/10): Python source surgery + scanner deletion (9909e7e)
- fix(phase1): remove deleted opening_bell_scanner.py from Dockerfile.council (d17e1ce)
- chore(phase1): add verification tooling + pre-snapshot (a6d7138)
- fix(phase1): harden snapshot + parity scripts per code review (d225468)
- chore(phase1): T+0 post-deploy snapshot and parity proof (b515fdb)
- docs(spec): Phase 1 — surgical removal of Radar + Opening Bell (2f115c3)
- docs(plan): Phase 1 Radar/OB removal — implementation plan (2f6e2c6)
- PR #1, #2: Phase 1 deploy + Dockerfile.council hotfix
- PR #11: Phase 1 Final Report — ACCEPTED

## Learning Engine Conservative Bypass

The `LearningEngine.compute_stage_weights()` and `build_prompt_context()`
functions had a SQL JOIN defect that collapsed all stage weights to
`{0.25 × 4}` regardless of actual data, silently underweighting Stage 4
by 10pp from the intended values for ~10 days. Bypass deployed at all 5
call sites to restore the literal `{0.15, 0.20, 0.30, 0.35}` weights.
Buggy functions left in place for future repair (tracked as C1-C4).
Admin Learning tab hollowed to remove the misleading "Mechanism Activation
Status" displays.

- docs(spec): Learning Engine conservative bypass design (a9b1847)
- docs(spec): add canadian_llm_council_brain.py:4830 to LE bypass scope (57d8cda)
- docs(plan): Learning Engine conservative bypass — implementation plan (22ad0dc)
- fix(council): bypass buggy compute_stage_weights at _build_consensus (0d21f14)
- fix(council): bypass build_prompt_context at all 4 stage entry points (8eba6ef)
- fix(council): bypass compute_stage_weights at result_dict assembly (c786a1c)
- fix(api): add bypassed_mechanisms field to /learning-state endpoint (cb77cca)
- fix(admin): hollow Learning tab with bypass stub message (25d68be)
- PR #3: Learning Engine conservative bypass
- PR #4: Admin Learning tab hollow stub

## User Activity Heartbeat

Replaced login-event tracking with a true 60-second visibility-gated
client heartbeat that posts to `/api/activity/heartbeat`. Lazy session
extend/rotate on each beat. COALESCE-aware admin Activity dashboard
query. Scoped delete of 68 contaminated legacy session rows. Resolved
the long-standing dashboard nonsense ("21h durations", "Active Today: 0").

- PR #7: feat: user activity heartbeat (8286a2d)

## Sibling A — Card + Conviction Polish

- PR #9: feat: IIC conviction score cleanup (Sibling A) (2f4de3b)
- PR #10: fix(spikecard): inline "No Scoring" placeholder in Smart bar row (80f2743)
- PR #13: feat(spikecard): rename History bar to Hit Rate + add low-confidence cue when n<100 (0ffd1f6)

## Sibling B — Parallel Council Refactor

Stages 1 (Sonnet) and 2 (Gemini) now run in parallel under a shared 600s
wall-clock cap, both consuming the full liquid universe independently.
Stage size limits adjusted (100 → 60 → 30 → 10). Cross-source data
quality flagging via FMP/EODHD comparison (Step 4e.5). Dual-listing
enrichment (Step 4g) overrides Canadian institutional ownership with
US 13F values for the 33 dual-listed TSX names. Hybrid FMP+EODHD fetch
layer.

New modules:
- `cross_compare.py` — FMP vs EODHD field-level cross-comparison
- `eodhd_enrichment.py` — EODHD fundamentals fetcher
- `us_dual_listing_enrichment.py` — US-market enrichment for dual-listed TSX names
- `dual_listing_map.json` — 33 TSX→US ticker mappings

Hotfix immediately after PR #15 merge:
- PR #16 added the new Python modules to `Dockerfile.council` so the
  council container could find them. Production restored within 7 minutes
  of the outage.

- PR #14: feat: ADV Slider admin control (Council tab) (dc2cef0)
- PR #15: feat: Sibling B parallel council refactor + hybrid FMP/EODHD + dual-listing (dc7fb4e)
- PR #16: hotfix(docker): COPY Sibling B modules into council container (ad62da4)

## Operational Hardening + Documentation

- feat(safety): daily backup + integrity check scripts (post-Session-10 trust restoration) (cc53da8)
- PR #5: chore(phase1)/post-snapshot to main (cherry-pick of afaf7fb)
- PR #6: docs: session handoff 2026-04-08 (8b74a80)
- PR #8: docs(handoff): mark D1, D2, E1 as closed (ce74862)
- PR #12: docs(session-16): specs + plan for B-i, ADV Slider, Sibling B (2a0d38d)
- PR #17: docs(session): 2026-04-09 handoff + queued plans (6898f1b)

## Audit Findings (no code changes)

- 2026-04-09: `.TO`-only ticker integrity audit. Verified the council
  pipeline produces only TSX-listed `.TO` tickers by construction. No
  leak found. Two latent risks identified (permissive Pydantic validator
  allowing `.V`, unvalidated `RunCouncilRequest.tickers` list) and
  deferred — not a current bug, defense-in-depth deferred to a future
  hardening PR.

## Production state at v6.0 cut

- HEAD: `ad62da4` (PR #16 hotfix)
- All 6 containers healthy (`app`, `council`, `cron`, `db`, `nginx`, `certbot`)
- LE bypass live, returning literal `{0.15, 0.20, 0.30, 0.35}` stage weights
- Phase 1 baseline parity verified (zero drift)
- 14 days of live data with 0 non-`.TO` tickers in `Spike` table
