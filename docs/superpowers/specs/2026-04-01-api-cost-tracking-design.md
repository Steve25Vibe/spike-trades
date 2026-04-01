# API Cost Tracking + Model Upgrades

**Date:** 2026-04-01
**Feature:** Per-stage API cost breakdown on Admin panel + upgrade Sonnet/Opus to 4.6
**Version:** Spike Trades Ver 3.5

---

## Hard Constraints

- **No database schema changes** (PostgreSQL or SQLite). Token data lives in the council output JSON only.
- **No existing historical data may be altered.**
- **Every task must be tested before proceeding to the next.**
- **All existing functionality must continue working** — council pipeline, Spike It, admin panel, accuracy tracking.

---

## Overview

Two changes bundled together:

1. **API Cost Tracking:** Capture token usage (input/output) from all LLM API responses, embed it in the council output JSON, and display a per-stage cost breakdown card on the Admin panel's Council tab.

2. **Model Upgrades:** Upgrade Stage 1 (Sonnet 4 to 4.6, same cost, better quality) and Stage 3 (Opus 4 to 4.6, 66% cost reduction).

---

## Part 1: Token Capture in LLM Callers

All three callers return `(text, usage)` tuples instead of just text.

- `_call_anthropic()`: Capture `stream.get_final_message().usage` → `input_tokens`, `output_tokens`
- `_call_grok()`: Capture `resp.usage.prompt_tokens`, `resp.usage.completion_tokens`
- `_call_gemini()`: Capture `resp.usage_metadata.prompt_token_count`, `resp.usage_metadata.candidates_token_count`

Fallback: If usage unavailable, return `{"input_tokens": 0, "output_tokens": 0}`.

All call sites updated: stage functions, Spike It endpoint.

---

## Part 2: Token Accumulation in Stage Functions

Each stage accumulates tokens across batches. `run_council()` writes into `stage_metadata.token_usage`:

```json
{
  "token_usage": {
    "stage1": {"model": "claude-sonnet-4-6-20250514", "input_tokens": 52000, "output_tokens": 8400},
    "stage2": {"model": "gemini-3.1-pro-preview", "input_tokens": 48000, "output_tokens": 7200},
    "stage3": {"model": "claude-opus-4-6-20250514", "input_tokens": 41000, "output_tokens": 6800},
    "stage4": {"model": "grok-4-0709", "input_tokens": 35000, "output_tokens": 5600}
  }
}
```

Saved in council output JSON. `/latest-output` returns it automatically.

---

## Part 3: Pricing & Cost Calculation

Pricing constant lives in the frontend admin page:

| Model String | Input/MTok | Output/MTok |
|-------------|-----------|-------------|
| `claude-sonnet-4-6-20250514` | $3.00 | $15.00 |
| `claude-opus-4-6-20250514` | $5.00 | $25.00 |
| `gemini-3.1-pro-preview` | $1.25 | $10.00 |
| `grok-4-0709` | $3.00 | $15.00 |

Fallback: unrecognized models use $15/$75 to avoid underreporting.

---

## Part 4: Admin Panel — Cost Card

New "Run Cost Breakdown" glass-card on Council tab showing:
- 4 line items: stage name + model, token counts ("52K in / 8.4K out"), dollar cost
- Divider + bold total
- Footer note for older runs without token data

---

## Part 5: Model Upgrades

- Stage 1: `claude-sonnet-4-20250514` → `claude-sonnet-4-6-20250514`
- Stage 3: `claude-opus-4-20250514` → `claude-opus-4-6-20250514`
- Stage 4 fallback: `claude-opus-4-20250514` → `claude-opus-4-6-20250514`

---

## Part 6: Version Bump

All page footers: "Ver 3.2" → "Ver 3.5". FEATURES.md updated.

---

## File Changes

### Modified Files
1. `canadian_llm_council_brain.py` — Callers return tuples; stages accumulate tokens; stage_metadata includes token_usage; model strings upgraded
2. `api_server.py` — Update Spike It call sites for new caller signatures
3. `src/app/admin/page.tsx` — New cost breakdown card + pricing constant
4. 8 page footer files — version bump
5. `FEATURES.md` — changelog
