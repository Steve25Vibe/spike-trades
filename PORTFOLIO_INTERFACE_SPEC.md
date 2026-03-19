# Perpetual Portfolio Interface — Build Specification

## Instructions for Claude Code

You are Claude 4.6 Opus, an elite full-stack Python architect specializing in clean,
modular UI/presentation layers for financial AI systems.

### CONTEXT

The backend brain module `canadian_llm_council_brain.py` (built from
`COUNCIL_BRAIN_SPEC.md`) runs a daily LLM council for Canadian (.TO) stocks
and outputs a dict with keys including:

- **raw_data**: full structured details (scores, 3/5/8-day forecasts, historical edge, risk metrics)
- **roadmap**: sequenced 10-trading-day plan (current holdings, entries, pyramiding, profit-taking, exits)
- **portfolio_snapshot**: current state + projected growth path (with confidence bands)
- **dashboard_friendly**: flat schema optimized for frontend consumption
- **human_readable_summary**: optional concise markdown string

### BUILD APPROACH

This module is built in **Session 5** (see `CLAUDE_CODE_BRIEF.md`).
It depends on the council brain's output. Build it AFTER Sessions 1–4 are
complete and `run_council()` produces clean, validated JSON output.

Write a checkpoint to `SESSION_TRANSITIONS.md` when the session is complete.

Testing protocol:
1. Save a real council output to `sample_council_output.json`.
2. Build the interface class, feeding it the saved JSON.
3. Test each render format individually (console → markdown → html → streamlit → slack).
4. Verify Streamlit dashboard runs and displays correctly with `streamlit run canadian_portfolio_interface.py`.
5. Verify the HTML output renders correctly when opened in a browser.

### What to Build

A **single, isolated, reusable presentation module** named
`canadian_portfolio_interface.py`.

This file should:
- Import the brain's output dict (assume it's passed in or loaded from JSON/file)
- Provide multiple clean ways to render the perpetual portfolio roadmap and
  daily recommendations
- Focus on usability, clarity, and visual appeal for a trader/investor

---

## Required Features

### 1. Console / Markdown Renderer
Pretty-print daily summary + 10-day roadmap table + growth projection.
Must be readable in a terminal and useful for logging.

### 2. Streamlit Dashboard
Interactive page showing:
- **Portfolio snapshot**: current value, risk exposure, projected path chart via Plotly
- **Roadmap timeline/table**: entries/exits with conviction color-coding
- **Top picks list**: with 3/5/8-day forecasts, conviction tiers, narratives
- **Macro regime note**: current regime + key levels (oil, gold, CAD, TSX)

### 3. HTML Email/Report Generator
Self-contained HTML string with tables and simple inline charts (use Plotly JSON
or static images). Must render correctly in email clients (Gmail, Outlook) —
use inline CSS, no external stylesheets.

### 4. Optional Slack/Discord Formatter
Markdown blocks + emojis. Format for Slack's mrkdwn syntax.

---

## Constraints

- Keep it modular — one main class `CanadianPortfolioInterface`
- Public method:
  ```python
  def render(self, daily_output_dict: dict, format: str = "streamlit") -> Any
  ```
  Supported formats: `"console"`, `"markdown"`, `"streamlit"`, `"html"`, `"slack"`
- Use only lightweight dependencies: `streamlit`, `pandas`, `plotly`, `jinja2`
  (for HTML templating), `python-dotenv` (optional)
- Assume the brain output is already validated and timestamped
- Include example usage at bottom (`__main__`) that loads a sample JSON and
  renders all formats
- Full type hints, docstrings, and error handling

---

## Output

The complete ready-to-run Python file `canadian_portfolio_interface.py`.
Test it against real council output before considering it done.
