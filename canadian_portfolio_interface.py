#!/usr/bin/env python3
"""
canadian_portfolio_interface.py — Perpetual Portfolio Interface for Spike Trades

Presentation layer for the Canadian LLM Council Brain output.
Renders council results in 5 formats: console, markdown, html, streamlit, slack.

Session 5 deliverable — see PORTFOLIO_INTERFACE_SPEC.md.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, date
from pathlib import Path
from typing import Any, Optional

import pandas as pd

# ═══════════════════════════════════════════════════════════════════════════
# HELPERS
# ═══════════════════════════════════════════════════════════════════════════

def _safe_get(d: dict, *keys: str, default: Any = None) -> Any:
    """Nested dict access with default."""
    for k in keys:
        if isinstance(d, dict):
            d = d.get(k, default)
        else:
            return default
    return d


def _fmt_pct(val: float | None, sign: bool = True) -> str:
    if val is None:
        return "N/A"
    s = f"{val:+.2f}%" if sign else f"{val:.2f}%"
    return s


def _fmt_dollar(val: float | None) -> str:
    if val is None:
        return "N/A"
    return f"${val:,.2f}"


def _fmt_price(val: float | None) -> str:
    if val is None:
        return "N/A"
    return f"${val:.2f}"


def _conviction_color(tier: str) -> str:
    """Return hex color for conviction tier."""
    return {"HIGH": "#00ff88", "MEDIUM": "#ffaa00", "LOW": "#ff4444"}.get(tier, "#888888")


def _conviction_emoji(tier: str) -> str:
    return {"HIGH": "🟢", "MEDIUM": "🟡", "LOW": "🔴"}.get(tier, "⚪")


def _direction_arrow(direction: str) -> str:
    return "↑" if direction.upper() == "UP" else "↓"


def _action_emoji(action: str) -> str:
    return {
        "ENTER": "🔵", "HOLD": "🟢", "EXIT": "🔴",
        "PYRAMID": "🔺", "ROTATE": "🔄"
    }.get(action.upper(), "⚪")


# ═══════════════════════════════════════════════════════════════════════════
# MAIN CLASS
# ═══════════════════════════════════════════════════════════════════════════

class CanadianPortfolioInterface:
    """Multi-format renderer for LLM Council output.

    Usage:
        interface = CanadianPortfolioInterface()
        output = interface.render(council_dict, format="console")
    """

    SUPPORTED_FORMATS = ("console", "markdown", "html", "streamlit", "slack")

    def render(self, data: dict, format: str = "streamlit", radar_tickers: set[str] | None = None) -> Any:
        """Render council output in the specified format.

        Args:
            data: Council result dict (from CouncilResult.model_dump()).
            format: One of 'console', 'markdown', 'html', 'streamlit', 'slack'.
            radar_tickers: Optional set of tickers flagged by Radar scanner.

        Returns:
            str for console/markdown/html/slack. None for streamlit (renders in-place).
        """
        if format not in self.SUPPORTED_FORMATS:
            raise ValueError(f"Unsupported format '{format}'. Use one of {self.SUPPORTED_FORMATS}")

        self._radar_tickers = radar_tickers or set()
        renderer = getattr(self, f"_render_{format}")
        return renderer(data)

    # ───────────────────────────────────────────────────────────────────
    # SHARED DATA EXTRACTION
    # ───────────────────────────────────────────────────────────────────

    def _extract(self, data: dict) -> dict:
        """Extract and normalize all sections from council output."""
        picks = data.get("top_picks", [])
        risk = data.get("risk_summary") or {}
        roadmap = data.get("daily_roadmap") or {}
        macro = data.get("macro_context") or {}
        allocs = risk.get("allocation_table", [])

        # Build allocation lookup by ticker
        alloc_map = {a["ticker"]: a for a in allocs}

        return {
            "run_date": data.get("run_date", "N/A"),
            "run_id": data.get("run_id", "N/A"),
            "regime": data.get("regime", "UNKNOWN"),
            "macro": macro,
            "picks": picks,
            "risk": risk,
            "alloc_map": alloc_map,
            "roadmap": roadmap,
            "roadmap_entries": roadmap.get("entries", []),
            "starting_value": roadmap.get("starting_portfolio_value", 100000),
            "universe_size": data.get("universe_size", 0),
            "tickers_screened": data.get("tickers_screened", 0),
            "runtime": data.get("total_runtime_seconds", 0),
            "fact_flags": data.get("fact_check_flags", []),
        }

    # ───────────────────────────────────────────────────────────────────
    # 1. CONSOLE RENDERER
    # ───────────────────────────────────────────────────────────────────

    def _render_console(self, data: dict) -> str:
        """Pretty-print for terminal output."""
        e = self._extract(data)
        lines: list[str] = []
        w = 80  # terminal width

        lines.append("=" * w)
        lines.append("  SPIKE TRADES — DAILY COUNCIL REPORT".center(w))
        lines.append(f"  {e['run_date']}  |  Regime: {e['regime']}".center(w))
        lines.append("=" * w)

        # Macro snapshot
        m = e["macro"]
        lines.append("")
        lines.append("─── MACRO CONTEXT ───")
        lines.append(
            f"  Oil (WTI): {_fmt_price(m.get('oil_wti'))}  |  "
            f"Gold: {_fmt_price(m.get('gold_price'))}  |  "
            f"CAD/USD: {m.get('cad_usd', 'N/A')}  |  "
            f"VIX: {m.get('vix', 'N/A')}"
        )
        lines.append(
            f"  TSX: {_fmt_price(m.get('tsx_composite'))} ({_fmt_pct(m.get('tsx_change_pct'))})  |  "
            f"Regime: {e['regime']}"
        )

        # Top picks
        lines.append("")
        lines.append("─── TOP PICKS ───")
        lines.append(f"  {'#':<3} {'Ticker':<10} {'Price':>8} {'Chg%':>7} {'Score':>6} {'Conv':>6} {'Stages':>6}")
        lines.append("  " + "-" * 52)
        for p in e["picks"]:
            lines.append(
                f"  {p['rank']:<3} {p['ticker']:<10} "
                f"{_fmt_price(p['price']):>8} "
                f"{_fmt_pct(p.get('change_pct')):>7} "
                f"{p['consensus_score']:>6.1f} "
                f"{p['conviction_tier']:>6} "
                f"{p['stages_appeared']:>6}"
            )

        # Forecasts for each pick
        lines.append("")
        lines.append("─── PROBABILISTIC FORECASTS ───")
        for p in e["picks"]:
            forecasts = p.get("forecasts", [])
            if not forecasts:
                continue
            lines.append(f"  {p['ticker']} ({p['conviction_tier']}):")
            for f in forecasts:
                arrow = _direction_arrow(f.get("predicted_direction", "UP"))
                lines.append(
                    f"    {f['horizon_days']}d: {arrow} {_fmt_pct(f.get('most_likely_move_pct'))} "
                    f"(P={f.get('direction_probability', 0):.0%}) "
                    f"[{_fmt_price(f.get('price_range_low'))} – {_fmt_price(f.get('price_range_high'))}]"
                )

        # Risk summary
        if e["risk"]:
            lines.append("")
            lines.append("─── RISK ALLOCATION ───")
            lines.append(
                f"  Positions: {e['risk'].get('total_positions', 0)}  |  "
                f"Total Heat: {_fmt_pct(e['risk'].get('total_heat_pct'), sign=False)}  |  "
                f"Max Position: {_fmt_pct(e['risk'].get('max_single_position_pct'), sign=False)}  |  "
                f"Avg Risk/Trade: {_fmt_pct(e['risk'].get('avg_risk_per_trade_pct'), sign=False)}"
            )
            if e["alloc_map"]:
                lines.append(f"  {'Ticker':<10} {'Shares':>7} {'Entry':>8} {'Stop':>8} {'$Risk':>9} {'Pos%':>6}")
                lines.append("  " + "-" * 52)
                for a in e["risk"].get("allocation_table", []):
                    lines.append(
                        f"  {a['ticker']:<10} {a['shares']:>7} "
                        f"{_fmt_price(a['entry_price']):>8} "
                        f"{_fmt_price(a['stop_loss']):>8} "
                        f"{_fmt_dollar(a['dollar_risk']):>9} "
                        f"{a['position_pct']:>5.1f}%"
                    )

        # Roadmap
        if e["roadmap_entries"]:
            lines.append("")
            lines.append("─── 10-DAY COMPOUNDING ROADMAP ───")
            lines.append(f"  Starting Portfolio: {_fmt_dollar(e['starting_value'])}")
            lines.append(f"  {'Day':<4} {'Date':<12} {'Action':<8} {'Projected':>12} {'Low':>12} {'High':>12} Tickers")
            lines.append("  " + "-" * 78)
            for r in e["roadmap_entries"]:
                tickers = ", ".join(r.get("tickers_involved", [])[:3])
                if len(r.get("tickers_involved", [])) > 3:
                    tickers += "..."
                lines.append(
                    f"  {r['day_number']:<4} {r['date']:<12} {r['action']:<8} "
                    f"{_fmt_dollar(r['projected_portfolio_value']):>12} "
                    f"{_fmt_dollar(r['confidence_band_low']):>12} "
                    f"{_fmt_dollar(r['confidence_band_high']):>12} {tickers}"
                )

        # Footer
        lines.append("")
        lines.append("=" * w)
        lines.append(
            f"  Universe: {e['universe_size']} → Screened: {e['tickers_screened']} → "
            f"Top {len(e['picks'])} picks  |  Runtime: {e['runtime']:.0f}s"
        )
        if e["fact_flags"]:
            lines.append(f"  ⚠ Fact-check flags: {', '.join(e['fact_flags'])}")
        lines.append(f"  Run ID: {e['run_id']}")
        lines.append("=" * w)

        return "\n".join(lines)

    # ───────────────────────────────────────────────────────────────────
    # 2. MARKDOWN RENDERER
    # ───────────────────────────────────────────────────────────────────

    def _render_markdown(self, data: dict) -> str:
        """Markdown output for docs/logging."""
        e = self._extract(data)
        lines: list[str] = []

        lines.append(f"# Spike Trades — Daily Council Report")
        lines.append(f"**{e['run_date']}** | Regime: **{e['regime']}**\n")

        # Macro
        m = e["macro"]
        lines.append("## Macro Context")
        lines.append(f"| Indicator | Value |")
        lines.append(f"|-----------|-------|")
        lines.append(f"| Oil (WTI) | {_fmt_price(m.get('oil_wti'))} |")
        lines.append(f"| Gold | {_fmt_price(m.get('gold_price'))} |")
        lines.append(f"| CAD/USD | {m.get('cad_usd', 'N/A')} |")
        lines.append(f"| VIX | {m.get('vix', 'N/A')} |")
        lines.append(f"| TSX | {_fmt_price(m.get('tsx_composite'))} ({_fmt_pct(m.get('tsx_change_pct'))}) |")
        lines.append("")

        # Top picks table
        lines.append("## Top Picks")
        lines.append("| # | Ticker | Price | Chg% | Score | Conviction | Stages | Catalyst |")
        lines.append("|---|--------|-------|------|-------|------------|--------|----------|")
        for p in e["picks"]:
            catalyst = (p.get("key_catalyst") or "")[:50]
            lines.append(
                f"| {p['rank']} | **{p['ticker']}** | {_fmt_price(p['price'])} | "
                f"{_fmt_pct(p.get('change_pct'))} | {p['consensus_score']:.1f} | "
                f"{p['conviction_tier']} | {p['stages_appeared']}/4 | {catalyst} |"
            )
        lines.append("")

        # Forecasts
        lines.append("## Probabilistic Forecasts")
        for p in e["picks"]:
            forecasts = p.get("forecasts", [])
            if not forecasts:
                continue
            lines.append(f"### {p['ticker']} ({p['conviction_tier']})")
            lines.append("| Horizon | Direction | Move | Probability | Price Range |")
            lines.append("|---------|-----------|------|-------------|-------------|")
            for f in forecasts:
                arrow = _direction_arrow(f.get("predicted_direction", "UP"))
                lines.append(
                    f"| {f['horizon_days']}d | {arrow} {f.get('predicted_direction', 'N/A')} | "
                    f"{_fmt_pct(f.get('most_likely_move_pct'))} | "
                    f"{f.get('direction_probability', 0):.0%} | "
                    f"{_fmt_price(f.get('price_range_low'))} – {_fmt_price(f.get('price_range_high'))} |"
                )
            lines.append("")

        # Risk
        if e["risk"]:
            lines.append("## Risk Allocation")
            lines.append(
                f"- **Positions**: {e['risk'].get('total_positions', 0)}\n"
                f"- **Total Heat**: {_fmt_pct(e['risk'].get('total_heat_pct'), sign=False)}\n"
                f"- **Max Position**: {_fmt_pct(e['risk'].get('max_single_position_pct'), sign=False)}\n"
                f"- **Avg Risk/Trade**: {_fmt_pct(e['risk'].get('avg_risk_per_trade_pct'), sign=False)}\n"
            )
            if e["alloc_map"]:
                lines.append("| Ticker | Shares | Entry | Stop | $Risk | Pos% |")
                lines.append("|--------|--------|-------|------|-------|------|")
                for a in e["risk"].get("allocation_table", []):
                    lines.append(
                        f"| {a['ticker']} | {a['shares']} | {_fmt_price(a['entry_price'])} | "
                        f"{_fmt_price(a['stop_loss'])} | {_fmt_dollar(a['dollar_risk'])} | "
                        f"{a['position_pct']:.1f}% |"
                    )
                lines.append("")

        # Roadmap
        if e["roadmap_entries"]:
            lines.append("## 10-Day Compounding Roadmap")
            lines.append(f"Starting Portfolio: **{_fmt_dollar(e['starting_value'])}**\n")
            lines.append("| Day | Date | Action | Projected | Low | High | Tickers |")
            lines.append("|-----|------|--------|-----------|-----|------|---------|")
            for r in e["roadmap_entries"]:
                tickers = ", ".join(r.get("tickers_involved", [])[:3])
                lines.append(
                    f"| {r['day_number']} | {r['date']} | {r['action']} | "
                    f"{_fmt_dollar(r['projected_portfolio_value'])} | "
                    f"{_fmt_dollar(r['confidence_band_low'])} | "
                    f"{_fmt_dollar(r['confidence_band_high'])} | {tickers} |"
                )
            lines.append("")

        # Footer
        lines.append("---")
        lines.append(
            f"*Universe: {e['universe_size']} → Screened: {e['tickers_screened']} → "
            f"Top {len(e['picks'])} | Runtime: {e['runtime']:.0f}s | Run: {e['run_id']}*"
        )

        return "\n".join(lines)

    # ───────────────────────────────────────────────────────────────────
    # 3. HTML EMAIL RENDERER
    # ───────────────────────────────────────────────────────────────────

    def _render_html(self, data: dict) -> str:
        """Self-contained HTML email with inline CSS."""
        e = self._extract(data)
        m = e["macro"]

        # Build picks rows
        radar_badge = '<span style="display:inline-block;background:#00FF4122;color:#00FF41;border:1px solid #00FF4144;padding:1px 6px;border-radius:8px;font-size:10px;font-weight:bold;margin-left:4px;vertical-align:middle;">RADAR</span>'

        pick_rows = ""
        for p in e["picks"]:
            color = _conviction_color(p["conviction_tier"])
            chg = p.get("change_pct", 0)
            chg_color = "#00ff88" if chg >= 0 else "#ff4444"
            is_radar = p["ticker"] in self._radar_tickers
            pick_rows += f"""
            <tr>
                <td style="padding:8px;border-bottom:1px solid #333;color:#ccc;">{p['rank']}</td>
                <td style="padding:8px;border-bottom:1px solid #333;font-weight:bold;color:#fff;">{p['ticker']}{radar_badge if is_radar else ''}</td>
                <td style="padding:8px;border-bottom:1px solid #333;color:#ccc;">{_fmt_price(p['price'])}</td>
                <td style="padding:8px;border-bottom:1px solid #333;color:{chg_color};">{_fmt_pct(chg)}</td>
                <td style="padding:8px;border-bottom:1px solid #333;color:#fff;font-weight:bold;">{p['consensus_score']:.1f}</td>
                <td style="padding:8px;border-bottom:1px solid #333;color:{color};font-weight:bold;">{p['conviction_tier']}</td>
                <td style="padding:8px;border-bottom:1px solid #333;color:#ccc;">{p['stages_appeared']}/4</td>
            </tr>"""

        # Build forecast rows
        forecast_html = ""
        for p in e["picks"]:
            forecasts = p.get("forecasts", [])
            if not forecasts:
                continue
            color = _conviction_color(p["conviction_tier"])
            forecast_html += f'<h3 style="color:{color};margin:16px 0 8px 0;">{p["ticker"]} — {p["conviction_tier"]}</h3>'
            forecast_html += """<table style="width:100%;border-collapse:collapse;margin-bottom:12px;">
            <tr style="border-bottom:2px solid #555;">
                <th style="padding:6px;text-align:left;color:#888;">Horizon</th>
                <th style="padding:6px;text-align:left;color:#888;">Dir</th>
                <th style="padding:6px;text-align:right;color:#888;">Move</th>
                <th style="padding:6px;text-align:right;color:#888;">Prob</th>
                <th style="padding:6px;text-align:right;color:#888;">Range</th>
            </tr>"""
            for f in forecasts:
                d_color = "#00ff88" if f.get("predicted_direction", "").upper() == "UP" else "#ff4444"
                forecast_html += f"""
                <tr>
                    <td style="padding:6px;border-bottom:1px solid #333;color:#ccc;">{f['horizon_days']}d</td>
                    <td style="padding:6px;border-bottom:1px solid #333;color:{d_color};">{_direction_arrow(f.get('predicted_direction','UP'))} {f.get('predicted_direction','N/A')}</td>
                    <td style="padding:6px;border-bottom:1px solid #333;text-align:right;color:#ccc;">{_fmt_pct(f.get('most_likely_move_pct'))}</td>
                    <td style="padding:6px;border-bottom:1px solid #333;text-align:right;color:#fff;font-weight:bold;">{f.get('direction_probability',0):.0%}</td>
                    <td style="padding:6px;border-bottom:1px solid #333;text-align:right;color:#ccc;">{_fmt_price(f.get('price_range_low'))} – {_fmt_price(f.get('price_range_high'))}</td>
                </tr>"""
            forecast_html += "</table>"

        # Allocation rows
        alloc_html = ""
        if e["alloc_map"]:
            alloc_html = """<h2 style="color:#00ccff;margin:24px 0 12px 0;">Risk Allocation</h2>
            <table style="width:100%;border-collapse:collapse;">
            <tr style="border-bottom:2px solid #555;">
                <th style="padding:6px;text-align:left;color:#888;">Ticker</th>
                <th style="padding:6px;text-align:right;color:#888;">Shares</th>
                <th style="padding:6px;text-align:right;color:#888;">Entry</th>
                <th style="padding:6px;text-align:right;color:#888;">Stop</th>
                <th style="padding:6px;text-align:right;color:#888;">$Risk</th>
                <th style="padding:6px;text-align:right;color:#888;">Pos%</th>
            </tr>"""
            for a in e["risk"].get("allocation_table", []):
                alloc_html += f"""
                <tr>
                    <td style="padding:6px;border-bottom:1px solid #333;color:#fff;font-weight:bold;">{a['ticker']}</td>
                    <td style="padding:6px;border-bottom:1px solid #333;text-align:right;color:#ccc;">{a['shares']}</td>
                    <td style="padding:6px;border-bottom:1px solid #333;text-align:right;color:#ccc;">{_fmt_price(a['entry_price'])}</td>
                    <td style="padding:6px;border-bottom:1px solid #333;text-align:right;color:#ff4444;">{_fmt_price(a['stop_loss'])}</td>
                    <td style="padding:6px;border-bottom:1px solid #333;text-align:right;color:#ffaa00;">{_fmt_dollar(a['dollar_risk'])}</td>
                    <td style="padding:6px;border-bottom:1px solid #333;text-align:right;color:#ccc;">{a['position_pct']:.1f}%</td>
                </tr>"""
            alloc_html += "</table>"

        # Roadmap rows
        roadmap_html = ""
        if e["roadmap_entries"]:
            final = e["roadmap_entries"][-1]
            gain = final["projected_portfolio_value"] - e["starting_value"]
            gain_pct = (gain / e["starting_value"]) * 100

            roadmap_html = f"""<h2 style="color:#00ccff;margin:24px 0 12px 0;">10-Day Compounding Roadmap</h2>
            <p style="color:#ccc;">Starting: <strong style="color:#fff;">{_fmt_dollar(e['starting_value'])}</strong>
            → Projected: <strong style="color:#00ff88;">{_fmt_dollar(final['projected_portfolio_value'])}</strong>
            (<span style="color:#00ff88;">{_fmt_pct(gain_pct)}</span>)</p>
            <table style="width:100%;border-collapse:collapse;">
            <tr style="border-bottom:2px solid #555;">
                <th style="padding:6px;text-align:left;color:#888;">Day</th>
                <th style="padding:6px;text-align:left;color:#888;">Date</th>
                <th style="padding:6px;text-align:left;color:#888;">Action</th>
                <th style="padding:6px;text-align:right;color:#888;">Projected</th>
                <th style="padding:6px;text-align:right;color:#888;">Low</th>
                <th style="padding:6px;text-align:right;color:#888;">High</th>
            </tr>"""
            for r in e["roadmap_entries"]:
                roadmap_html += f"""
                <tr>
                    <td style="padding:6px;border-bottom:1px solid #333;color:#ccc;">{r['day_number']}</td>
                    <td style="padding:6px;border-bottom:1px solid #333;color:#ccc;">{r['date']}</td>
                    <td style="padding:6px;border-bottom:1px solid #333;color:#fff;">{r['action']}</td>
                    <td style="padding:6px;border-bottom:1px solid #333;text-align:right;color:#00ff88;font-weight:bold;">{_fmt_dollar(r['projected_portfolio_value'])}</td>
                    <td style="padding:6px;border-bottom:1px solid #333;text-align:right;color:#ffaa00;">{_fmt_dollar(r['confidence_band_low'])}</td>
                    <td style="padding:6px;border-bottom:1px solid #333;text-align:right;color:#ffaa00;">{_fmt_dollar(r['confidence_band_high'])}</td>
                </tr>"""
            roadmap_html += "</table>"

        risk_summary_html = ""
        if e["risk"]:
            risk_summary_html = f"""
            <div style="display:flex;gap:24px;margin:16px 0;flex-wrap:wrap;">
                <div style="background:#1a1a2e;padding:12px 20px;border-radius:8px;border:1px solid #333;">
                    <div style="color:#888;font-size:12px;">Positions</div>
                    <div style="color:#fff;font-size:20px;font-weight:bold;">{e['risk'].get('total_positions', 0)}</div>
                </div>
                <div style="background:#1a1a2e;padding:12px 20px;border-radius:8px;border:1px solid #333;">
                    <div style="color:#888;font-size:12px;">Total Heat</div>
                    <div style="color:#ffaa00;font-size:20px;font-weight:bold;">{_fmt_pct(e['risk'].get('total_heat_pct'), sign=False)}</div>
                </div>
                <div style="background:#1a1a2e;padding:12px 20px;border-radius:8px;border:1px solid #333;">
                    <div style="color:#888;font-size:12px;">Max Position</div>
                    <div style="color:#fff;font-size:20px;font-weight:bold;">{_fmt_pct(e['risk'].get('max_single_position_pct'), sign=False)}</div>
                </div>
                <div style="background:#1a1a2e;padding:12px 20px;border-radius:8px;border:1px solid #333;">
                    <div style="color:#888;font-size:12px;">Avg Risk/Trade</div>
                    <div style="color:#fff;font-size:20px;font-weight:bold;">{_fmt_pct(e['risk'].get('avg_risk_per_trade_pct'), sign=False)}</div>
                </div>
            </div>"""

        html = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0d0d1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<div style="max-width:700px;margin:0 auto;padding:24px;background:#0d0d1a;">

    <!-- Header -->
    <div style="text-align:center;padding:20px 0;border-bottom:2px solid #00ccff;">
        <h1 style="margin:0;color:#00ccff;font-size:28px;">SPIKE TRADES</h1>
        <p style="margin:4px 0 0 0;color:#888;font-size:14px;">Daily Council Report — {e['run_date']}</p>
    </div>

    <!-- Regime Badge -->
    <div style="text-align:center;margin:16px 0;">
        <span style="background:#1a1a2e;color:#ffaa00;padding:6px 16px;border-radius:20px;border:1px solid #ffaa00;font-size:13px;">
            Regime: {e['regime']}
        </span>
    </div>

    <!-- Macro Bar -->
    <div style="background:#111128;padding:12px 16px;border-radius:8px;margin:16px 0;color:#ccc;font-size:13px;text-align:center;">
        Oil: <strong style="color:#fff;">{_fmt_price(m.get('oil_wti'))}</strong> &nbsp;|&nbsp;
        Gold: <strong style="color:#fff;">{_fmt_price(m.get('gold_price'))}</strong> &nbsp;|&nbsp;
        CAD/USD: <strong style="color:#fff;">{m.get('cad_usd', 'N/A')}</strong> &nbsp;|&nbsp;
        VIX: <strong style="color:#fff;">{m.get('vix', 'N/A')}</strong>
    </div>

    <!-- Top Picks -->
    <h2 style="color:#00ccff;margin:24px 0 12px 0;">Today's Spikes</h2>
    <table style="width:100%;border-collapse:collapse;">
        <tr style="border-bottom:2px solid #555;">
            <th style="padding:8px;text-align:left;color:#888;">#</th>
            <th style="padding:8px;text-align:left;color:#888;">Ticker</th>
            <th style="padding:8px;text-align:right;color:#888;">Price</th>
            <th style="padding:8px;text-align:right;color:#888;">Chg%</th>
            <th style="padding:8px;text-align:right;color:#888;">Score</th>
            <th style="padding:8px;text-align:left;color:#888;">Conv</th>
            <th style="padding:8px;text-align:center;color:#888;">Stages</th>
        </tr>
        {pick_rows}
    </table>

    <!-- Forecasts -->
    <h2 style="color:#00ccff;margin:24px 0 12px 0;">Probabilistic Forecasts</h2>
    {forecast_html}

    <!-- Risk Summary Cards -->
    {risk_summary_html}

    <!-- Allocation Table -->
    {alloc_html}

    <!-- Roadmap -->
    {roadmap_html}

    <!-- Footer -->
    <div style="margin-top:32px;padding-top:16px;border-top:1px solid #333;text-align:center;color:#666;font-size:11px;">
        Universe: {e['universe_size']} → Screened: {e['tickers_screened']} → Top {len(e['picks'])} picks
        &nbsp;|&nbsp; Runtime: {e['runtime']:.0f}s &nbsp;|&nbsp; {e['run_id']}<br>
        <span style="color:#444;">Generated by Spike Trades LLM Council</span>
    </div>

</div>
</body>
</html>"""
        return html

    # ───────────────────────────────────────────────────────────────────
    # 4. STREAMLIT DASHBOARD
    # ───────────────────────────────────────────────────────────────────

    def _render_streamlit(self, data: dict) -> None:
        """Render interactive Streamlit dashboard. Call from `streamlit run`."""
        import streamlit as st
        import plotly.graph_objects as go

        e = self._extract(data)
        m = e["macro"]

        st.set_page_config(page_title="Spike Trades — Council Dashboard", layout="wide")

        # Custom CSS
        st.markdown("""
        <style>
            .stApp { background-color: #0d0d1a; }
            .block-container { padding-top: 1rem; }
            h1, h2, h3 { color: #00ccff !important; }
        </style>
        """, unsafe_allow_html=True)

        # Header
        st.title("SPIKE TRADES — Council Dashboard")
        st.caption(f"{e['run_date']} | Regime: **{e['regime']}** | Runtime: {e['runtime']:.0f}s")

        # Macro metrics row
        col1, col2, col3, col4, col5 = st.columns(5)
        col1.metric("Oil (WTI)", _fmt_price(m.get("oil_wti")))
        col2.metric("Gold", _fmt_price(m.get("gold_price")))
        col3.metric("CAD/USD", f"{m.get('cad_usd', 'N/A')}")
        col4.metric("VIX", f"{m.get('vix', 'N/A')}")
        col5.metric("TSX", _fmt_price(m.get("tsx_composite")), f"{m.get('tsx_change_pct', 0):.2f}%")

        st.divider()

        # Risk summary cards
        if e["risk"]:
            st.subheader("Portfolio Risk")
            c1, c2, c3, c4 = st.columns(4)
            c1.metric("Positions", e["risk"].get("total_positions", 0))
            c2.metric("Total Heat", _fmt_pct(e["risk"].get("total_heat_pct"), sign=False))
            c3.metric("Max Position", _fmt_pct(e["risk"].get("max_single_position_pct"), sign=False))
            c4.metric("Avg Risk/Trade", _fmt_pct(e["risk"].get("avg_risk_per_trade_pct"), sign=False))

        # Roadmap chart
        if e["roadmap_entries"]:
            st.subheader("10-Day Compounding Roadmap")

            dates = [r["date"] for r in e["roadmap_entries"]]
            projected = [r["projected_portfolio_value"] for r in e["roadmap_entries"]]
            low = [r["confidence_band_low"] for r in e["roadmap_entries"]]
            high = [r["confidence_band_high"] for r in e["roadmap_entries"]]

            fig = go.Figure()
            # Confidence band
            fig.add_trace(go.Scatter(
                x=dates + dates[::-1],
                y=high + low[::-1],
                fill="toself",
                fillcolor="rgba(0,204,255,0.1)",
                line=dict(color="rgba(0,0,0,0)"),
                name="68% Confidence Band",
                hoverinfo="skip",
            ))
            # Projected line
            fig.add_trace(go.Scatter(
                x=dates, y=projected,
                mode="lines+markers",
                line=dict(color="#00ccff", width=3),
                marker=dict(size=8, color="#00ccff"),
                name="Projected Value",
            ))
            fig.update_layout(
                template="plotly_dark",
                paper_bgcolor="#0d0d1a",
                plot_bgcolor="#0d0d1a",
                yaxis_title="Portfolio Value ($)",
                xaxis_title="Date",
                height=400,
                margin=dict(l=60, r=20, t=20, b=40),
                legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
            )
            st.plotly_chart(fig, use_container_width=True)

        st.divider()

        # Top picks table
        st.subheader(f"Today's Spikes — Top {len(e['picks'])}")

        picks_df = pd.DataFrame([
            {
                "Rank": p["rank"],
                "Ticker": p["ticker"],
                "Sector": p.get("sector", ""),
                "Price": p["price"],
                "Chg%": p.get("change_pct", 0),
                "Score": p["consensus_score"],
                "Conviction": p["conviction_tier"],
                "Stages": f"{p['stages_appeared']}/4",
                "Catalyst": (p.get("key_catalyst") or "")[:60],
            }
            for p in e["picks"]
        ])

        st.dataframe(
            picks_df,
            use_container_width=True,
            hide_index=True,
            column_config={
                "Price": st.column_config.NumberColumn(format="$%.2f"),
                "Chg%": st.column_config.NumberColumn(format="%.2f%%"),
                "Score": st.column_config.NumberColumn(format="%.1f"),
            },
        )

        # Expandable detail per pick
        st.subheader("Pick Details & Forecasts")
        for p in e["picks"]:
            with st.expander(f"#{p['rank']} — {p['ticker']} ({p['conviction_tier']}) — Score: {p['consensus_score']:.1f}"):
                # Info columns
                ic1, ic2, ic3 = st.columns(3)
                ic1.write(f"**Sector:** {p.get('sector', 'N/A')}")
                ic2.write(f"**Price:** {_fmt_price(p['price'])} ({_fmt_pct(p.get('change_pct'))})")
                ic3.write(f"**Edge Multiplier:** {p.get('historical_edge_multiplier', 1.0):.2f}x")

                if p.get("key_catalyst"):
                    st.info(f"**Catalyst:** {p['key_catalyst']}")
                if p.get("kill_condition"):
                    st.error(f"**Kill Condition:** {p['kill_condition']}")
                if p.get("worst_case_scenario"):
                    st.warning(f"**Worst Case:** {p['worst_case_scenario']}")

                # Forecasts
                forecasts = p.get("forecasts", [])
                if forecasts:
                    fc_df = pd.DataFrame([
                        {
                            "Horizon": f"{f['horizon_days']}d",
                            "Direction": f"{_direction_arrow(f.get('predicted_direction', 'UP'))} {f.get('predicted_direction', 'N/A')}",
                            "Move": f.get("most_likely_move_pct", 0),
                            "Probability": f.get("direction_probability", 0),
                            "Range Low": f.get("price_range_low", 0),
                            "Range High": f.get("price_range_high", 0),
                        }
                        for f in forecasts
                    ])
                    st.dataframe(
                        fc_df,
                        use_container_width=True,
                        hide_index=True,
                        column_config={
                            "Move": st.column_config.NumberColumn(format="%.2f%%"),
                            "Probability": st.column_config.ProgressColumn(min_value=0, max_value=1, format="%.0f%%"),
                            "Range Low": st.column_config.NumberColumn(format="$%.2f"),
                            "Range High": st.column_config.NumberColumn(format="$%.2f"),
                        },
                    )

                # Stage score comparison
                stage_scores = p.get("stage_scores", {})
                if stage_scores:
                    scores_data = []
                    for stage_name, s in stage_scores.items():
                        if isinstance(s, dict):
                            scores_data.append({
                                "Stage": stage_name.replace("stage", "S"),
                                "Total": s.get("total", 0),
                                "Technical": s.get("technical_momentum", 0),
                                "Sentiment": s.get("sentiment_catalysts", 0),
                                "Vol/Options": s.get("options_volatility", 0),
                                "Risk/Reward": s.get("risk_reward", 0),
                                "Conviction": s.get("conviction", 0),
                            })
                    if scores_data:
                        st.dataframe(pd.DataFrame(scores_data), use_container_width=True, hide_index=True)

                # Allocation info
                alloc = e["alloc_map"].get(p["ticker"])
                if alloc:
                    ac1, ac2, ac3, ac4 = st.columns(4)
                    ac1.metric("Shares", alloc["shares"])
                    ac2.metric("Entry", _fmt_price(alloc["entry_price"]))
                    ac3.metric("Stop Loss", _fmt_price(alloc["stop_loss"]))
                    ac4.metric("$Risk", _fmt_dollar(alloc["dollar_risk"]))

        # Roadmap table
        if e["roadmap_entries"]:
            st.divider()
            st.subheader("Roadmap Details")
            rm_df = pd.DataFrame([
                {
                    "Day": r["day_number"],
                    "Date": r["date"],
                    "Action": r["action"],
                    "Projected": r["projected_portfolio_value"],
                    "Low": r["confidence_band_low"],
                    "High": r["confidence_band_high"],
                    "Tickers": ", ".join(r.get("tickers_involved", [])),
                    "Notes": r.get("notes", ""),
                }
                for r in e["roadmap_entries"]
            ])
            st.dataframe(
                rm_df,
                use_container_width=True,
                hide_index=True,
                column_config={
                    "Projected": st.column_config.NumberColumn(format="$%,.2f"),
                    "Low": st.column_config.NumberColumn(format="$%,.2f"),
                    "High": st.column_config.NumberColumn(format="$%,.2f"),
                },
            )

        # Footer
        st.divider()
        st.caption(
            f"Universe: {e['universe_size']} → Screened: {e['tickers_screened']} → "
            f"Top {len(e['picks'])} picks | Runtime: {e['runtime']:.0f}s | {e['run_id']}"
        )

    # ───────────────────────────────────────────────────────────────────
    # 5. SLACK FORMATTER
    # ───────────────────────────────────────────────────────────────────

    def _render_slack(self, data: dict) -> str:
        """Slack mrkdwn formatter with emojis."""
        e = self._extract(data)
        m = e["macro"]
        blocks: list[str] = []

        blocks.append(f":chart_with_upwards_trend: *SPIKE TRADES — Daily Council Report*")
        blocks.append(f"_{e['run_date']}_ | Regime: *{e['regime']}*\n")

        # Macro
        blocks.append(
            f":oil_drum: Oil: *{_fmt_price(m.get('oil_wti'))}* | "
            f":large_yellow_circle: Gold: *{_fmt_price(m.get('gold_price'))}* | "
            f":dollar: CAD/USD: *{m.get('cad_usd', 'N/A')}* | "
            f":warning: VIX: *{m.get('vix', 'N/A')}*"
        )

        # Top picks
        blocks.append("\n:fire: *Today's Spikes*")
        for p in e["picks"]:
            emoji = _conviction_emoji(p["conviction_tier"])
            chg = p.get("change_pct", 0)
            chg_str = f"+{chg:.2f}%" if chg >= 0 else f"{chg:.2f}%"
            blocks.append(
                f"{emoji} *#{p['rank']} {p['ticker']}* — "
                f"{_fmt_price(p['price'])} ({chg_str}) — "
                f"Score: *{p['consensus_score']:.1f}* [{p['conviction_tier']}] "
                f"({p['stages_appeared']}/4 stages)"
            )

        # Forecasts summary (top 3 only for Slack brevity)
        blocks.append("\n:crystal_ball: *Forecasts (Top 3)*")
        for p in e["picks"][:3]:
            forecasts = p.get("forecasts", [])
            if not forecasts:
                continue
            fc_strs = []
            for f in forecasts:
                arrow = ":arrow_up:" if f.get("predicted_direction", "").upper() == "UP" else ":arrow_down:"
                fc_strs.append(
                    f"{f['horizon_days']}d {arrow} {_fmt_pct(f.get('most_likely_move_pct'))} "
                    f"(P={f.get('direction_probability', 0):.0%})"
                )
            blocks.append(f"  *{p['ticker']}*: {' | '.join(fc_strs)}")

        # Risk
        if e["risk"]:
            blocks.append(
                f"\n:shield: *Risk*: {e['risk'].get('total_positions', 0)} positions, "
                f"Heat: {_fmt_pct(e['risk'].get('total_heat_pct'), sign=False)}, "
                f"Avg Risk: {_fmt_pct(e['risk'].get('avg_risk_per_trade_pct'), sign=False)}/trade"
            )

        # Roadmap summary
        if e["roadmap_entries"]:
            final = e["roadmap_entries"][-1]
            gain = final["projected_portfolio_value"] - e["starting_value"]
            gain_pct = (gain / e["starting_value"]) * 100
            blocks.append(
                f"\n:rocket: *10-Day Roadmap*: {_fmt_dollar(e['starting_value'])} → "
                f"{_fmt_dollar(final['projected_portfolio_value'])} "
                f"({_fmt_pct(gain_pct)})"
            )

        # Footer
        blocks.append(
            f"\n_Universe: {e['universe_size']} → {e['tickers_screened']} screened → "
            f"Top {len(e['picks'])} | {e['runtime']:.0f}s | `{e['run_id']}`_"
        )

        return "\n".join(blocks)


# ═══════════════════════════════════════════════════════════════════════════
# CLI / MAIN
# ═══════════════════════════════════════════════════════════════════════════

def _load_data(path: str = "session4_output.json") -> dict:
    """Load council output JSON."""
    p = Path(path)
    if not p.exists():
        print(f"ERROR: {path} not found. Run the council brain first.", file=sys.stderr)
        sys.exit(1)
    with open(p) as f:
        return json.load(f)


def main() -> None:
    """CLI entry point. Usage: python3 canadian_portfolio_interface.py [format] [json_path]"""
    import argparse

    parser = argparse.ArgumentParser(description="Spike Trades Portfolio Interface")
    parser.add_argument("format", nargs="?", default="console",
                        choices=CanadianPortfolioInterface.SUPPORTED_FORMATS,
                        help="Output format (default: console)")
    parser.add_argument("--data", default="session4_output.json",
                        help="Path to council output JSON")
    parser.add_argument("--output", "-o", default=None,
                        help="Write output to file (for html/markdown)")
    args = parser.parse_args()

    data = _load_data(args.data)
    interface = CanadianPortfolioInterface()

    if args.format == "streamlit":
        # When run directly, re-exec under streamlit
        print("Launching Streamlit dashboard...")
        import subprocess
        subprocess.run(["streamlit", "run", __file__, "--", "--data", args.data])
        return

    result = interface.render(data, format=args.format)

    if args.output:
        Path(args.output).write_text(result, encoding="utf-8")
        print(f"Output written to {args.output}", file=sys.stderr)
    else:
        print(result)


# Streamlit entry point — detected when run via `streamlit run`
def _streamlit_entry() -> None:
    """Entry point when invoked via `streamlit run canadian_portfolio_interface.py`."""
    import sys as _sys
    # Parse --data from streamlit args
    data_path = "session4_output.json"
    args = _sys.argv[1:]
    for i, arg in enumerate(args):
        if arg == "--data" and i + 1 < len(args):
            data_path = args[i + 1]
            break

    data = _load_data(data_path)
    interface = CanadianPortfolioInterface()
    interface.render(data, format="streamlit")


# Auto-detect if running under streamlit
try:
    import streamlit as _st
    if hasattr(_st, "runtime") and _st.runtime.exists():
        _streamlit_entry()
except (ImportError, Exception):
    pass

if __name__ == "__main__":
    main()
