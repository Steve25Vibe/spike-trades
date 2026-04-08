# Phase 1 — Plan Delta Notes

Companion to: `2026-04-07-phase-1-radar-ob-removal.md`
Created: 2026-04-07 (Task 0 execution)

This file records the small but deliberate ways Phase 1 execution diverged from
the plan's verbatim script content. The divergences are tooling fixes only —
no goal, scope, commit boundary, or verification requirement changed.

## Delta 1 — `scripts/phase1_snapshot.sh` SQL quoting

**Plan text:**
```bash
ssh -i "$SSH_KEY" "$SSH_TARGET" "cd /opt/spike-trades && docker compose exec -T db psql -U spiketrades -d spiketrades -At -F'|' -c \"$SQL\"" \
  | tee "$OUT"
```

**Committed text:**
```bash
ssh -i "$SSH_KEY" "$SSH_TARGET" 'cd /opt/spike-trades && docker compose exec -T db psql -U spiketrades -d spiketrades -At -F"|"' <<<"$SQL" \
  | tee "$OUT"
```

**Why:** The plan passed `$SQL` through `-c "$SQL"` inside an already-double-quoted
remote command. When the outer double-quoting collapsed, the inner `"RadarReport"`
identifier quotes were stripped and psql saw the folded-lowercase bare identifier
`radarreport`, producing `relation "radarreport" does not exist`.

Piping SQL over stdin keeps identifier casing intact without any quoting gymnastics.
Confirmed working against production on 2026-04-08T00:33:32Z — all 13 metric rows
returned, all 4 archived tables resolved correctly.

## Delta 2 — `scripts/phase1_verify.sh` always-on gate checks

**Plan text:**
```bash
check "build"  npm run build
check "lint"   npm run lint
check "tests (JS/TS)"  bash -c 'npm test -- --silent --watchAll=false 2>&1'
check "tests (Python)" bash -c 'python3 -m pytest tests/ -q --tb=no 2>&1'
```

**Committed text:**
```bash
check "build"  npm run build
```

**Why — four separate problems with the original:**

1. **`npm run lint`** resolves to `next lint`, which is deprecated in Next 15
   and launches an interactive ESLint-config wizard when no `.eslintrc*` file
   exists (none does in this repo). In a non-interactive verify-gate context
   it hangs. No historical repo state in which this line worked has been found.

2. **`npm test`** exits with `Missing script: "test"`. There is no `test` script
   in `package.json` and no jest/vitest/mocha dependency. The sole JS test file
   (`src/__tests__/opening-bell-api.test.ts`) has apparently never been runnable
   in this repo, and Commit 1 deletes it anyway.

3. **`pytest tests/`** fails baseline because the three doomed Radar/OB test
   files have collection errors against the current tree (scheduled for
   deletion in Commit 1 — fine). The one non-doomed file,
   `tests/test_fmp_ultimate.py`, turns out to not be a real pytest test at
   all: it's a standalone async helper script whose `test_endpoint` function
   takes positional parameters pytest mis-collects as missing fixtures.
   So there is no working Python test at the pytest level in this repo.

4. **Python imports of production files** (e.g., `python3 -c "import api_server"`
   in the original Commit 10 stringency block) fail locally with
   `ModuleNotFoundError: No module named 'dotenv'` because the production
   Python deps only exist inside the Docker container, not on the dev host.

**What the committed always-on gate catches:** `npm run build` runs Next.js's
TypeScript checker, compiles all 47 routes, and fails on any missing import,
unresolved type, or broken module graph — exactly the regression class
Phase 1's surgical removal needs to prevent for Commits 1–9.

**Commit 10 Python stringency:** The plan's `python3 -c "import X"` lines for
Commit 10 are replaced with `python3 -m py_compile X.py`, which does syntax
validation without needing the container's runtime env. Deeper runtime
verification (actual imports against live deps) happens at Task 11 when we
hit `/healthz` and exercise endpoints on the deployed container.

**What the committed gate no longer catches:** ESLint style violations,
JS unit tests, pytest-level Python tests — none of which existed as working
gates in this repo. Nothing that previously caught regressions has been lost.

## Delta 3 — `scripts/phase1_verify.sh` Commit 10 case block

**Plan text:**
```bash
check "python: api_server imports cleanly" python3 -c "import api_server"
check "python: council brain imports cleanly" python3 -c "import canadian_llm_council_brain"
# ...etc...
```

**Committed text:**
```bash
check "python: api_server syntax"            python3 -m py_compile api_server.py
check "python: council brain syntax"         python3 -m py_compile canadian_llm_council_brain.py
# ...etc...
```

**Why:** See Delta 2 item 4 — imports require the container's runtime env.
`py_compile` catches the failure modes we actually care about in a code-only
surgery (syntax errors, indentation errors, unterminated strings) without
needing any production dep. Real import verification happens at Task 11.

## Non-deltas (plan is authoritative, no changes)

- Commit boundaries, task order, two-keys-to-fire gates on Tasks 6 and 10
- All `case "$COMMIT"` per-commit stringency checks in phase1_verify.sh
- `scripts/phase1_db_parity.sh` — unchanged from plan text
- File manifests (delete lists, modify lists, preservation list)
- Database zero-touch guarantee
- Protected-file rule (SpikeCard surgical exception still requires Task 6 two-keys)
