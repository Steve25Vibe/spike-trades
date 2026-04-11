# Admin Panel Liveness + Progress Display — Design Spec

**Date:** 2026-04-11
**Version:** v6.2
**Status:** Approved — ready for implementation plan
**Priority:** After MPE ships

---

## Problem

When a council scan is running (45-55 minutes), the admin panel's Council tab goes completely dark. The status indicators stop updating, health checks fail, and the panel appears frozen. This is because the Python FastAPI server runs on a single uvicorn worker with a single event loop, and all three LLM API clients (Anthropic, Gemini, Grok) use synchronous SDK calls that block the event loop for 1-3 minutes per batch.

While the event loop is blocked processing an LLM call, incoming HTTP requests (`/health`, `/run-status`) queue up and timeout. The admin panel polls every 5 seconds, gets no response, and shows stale data.

The ProgressTracker class already captures stage transitions and batch counts internally — but no HTTP request can reach it because the event loop is frozen.

## Solution (Two Phases)

### Phase 1: Thread Pool Offload (Immediate Fix)

Wrap synchronous LLM API calls in `asyncio.to_thread()`. This runs the blocking call in a separate OS thread while the event loop stays free to handle HTTP requests.

**Files changed:** `canadian_llm_council_brain.py` — 3 functions:
- `_call_anthropic()`: wrap `client.messages.stream()` in `asyncio.to_thread()`
- `_call_gemini()`: wrap `genai.Client().models.generate_content()` in `asyncio.to_thread()`
- `_call_grok()`: wrap `OpenAI().chat.completions.create()` in `asyncio.to_thread()`

**Risk:** Low. Python's GIL doesn't affect I/O-bound operations (network calls to LLM APIs). The blocking code runs identically in a thread — just doesn't freeze the event loop.

**Result:** `/health` and `/run-status` endpoints respond instantly during scans. Admin panel stays live.

### Phase 2: Async SDK Migration (Follow-up)

Replace synchronous SDK clients with async counterparts:
- `anthropic.Anthropic()` → `anthropic.AsyncAnthropic()`
- `openai.OpenAI()` → `openai.AsyncOpenAI()`
- `genai.Client()` → async-compatible calls

**Benefit:** Opens the door to parallel LLM calls across batches, potentially cutting scan time from 55 minutes to 20-30 minutes. Not blocking for liveness fix.

---

## Progress Display UI

### Full Progress Panel (Admin Council Tab)

An expandable panel that appears at the top of the Council tab when a scan is running.

**Stage ticker bar:**
```
[Sonnet ✓ 10:23] [Gemini ▶ batch 3/10] [Opus •] [Grok •]
```
- Completed stages show green check + duration
- Active stage shows play icon + current batch progress
- Pending stages show dot

**Detail section (expanded):**
- Tickers being processed in current batch
- Per-batch timing (avg seconds per batch)
- Estimated time remaining (based on avg batch time × remaining batches)
- Stage-by-stage completion log with timestamps

**Data source:** `/run-status` endpoint, polled every 5 seconds during active run. Already returns stage, batch, and ticker data via ProgressTracker — just needs the event loop unblocked (Phase 1) to serve it.

---

## Root Cause Summary

| Factor | Issue | Fix |
|--------|-------|-----|
| Single event loop | Synchronous LLM calls block all HTTP handling | Phase 1: to_thread() |
| Synchronous SDK clients | anthropic.Anthropic(), OpenAI(), genai.Client() | Phase 2: async clients |
| Single uvicorn worker | No parallel request handling | Phase 1 makes this unnecessary |
| ProgressTracker data unreachable | Updates exist in memory but event loop can't serve them | Phase 1 unblocks serving |
