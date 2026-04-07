"""One-time recovery script for accuracy_records table.

Rebuilds the Today's Spikes learning system's accuracy_records table from the
Prisma (Postgres) Spike table's actual3Day/5Day/8Day columns, after Session 10's
destructive DELETE wiped the entire table on 2026-04-06.

Reads:
  - /tmp/spike_actuals.json  (dumped from Postgres — see Task 16 in session plan)
  - /app/data/spike_trades_council.db  (SQLite council DB)

Writes:
  - accuracy_records rows (INSERT OR IGNORE, safe to re-run)

Zero FMP calls. Zero writes to pick_history or stage_scores.
Matching key: (ticker, run_date) where run_date is YYYY-MM-DD.

Skips orphan pick_history rows that have no matching Prisma Spike row
(Option C from the Session 13 brainstorming — preserves audit trail
without polluting gate counts with permanently-unresolvable rows).

Usage (run inside council container):
  python3 /app/scripts/recover_accuracy_records.py /tmp/spike_actuals.json
"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

DB_PATH = "/app/data/spike_trades_council.db"


def main(dump_path: str) -> int:
    dump_file = Path(dump_path)
    if not dump_file.exists():
        print(f"ERROR: dump file not found at {dump_path}", file=sys.stderr)
        return 1

    with dump_file.open() as f:
        dump = json.load(f)

    if not isinstance(dump, list):
        print(
            "ERROR: dump must be a JSON array of {run_date, ticker, actual3Day, ...} objects",
            file=sys.stderr,
        )
        return 1

    # Build (ticker, run_date) -> row index for fast lookup
    index: dict[tuple[str, str], dict] = {}
    for row in dump:
        key = (row["ticker"], row["run_date"])
        index[key] = row

    print(f"Loaded {len(dump)} Prisma Spike rows from {dump_path}")

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    before_total = conn.execute("SELECT COUNT(*) FROM accuracy_records").fetchone()[0]
    before_resolved = conn.execute(
        "SELECT COUNT(*) FROM accuracy_records WHERE accurate IS NOT NULL"
    ).fetchone()[0]

    pick_rows = conn.execute(
        """
        SELECT id, ticker, run_date, entry_price, predicted_direction,
               forecast_3d_move_pct, forecast_3d_direction,
               forecast_5d_move_pct, forecast_5d_direction,
               forecast_8d_move_pct, forecast_8d_direction
        FROM pick_history
        WHERE forecast_3d_move_pct IS NOT NULL
        """
    ).fetchall()

    print(f"Found {len(pick_rows)} pick_history rows with forecasts")

    matched = 0
    placeholder = 0
    resolved = 0
    orphan_skipped = 0

    try:
        for pick in pick_rows:
            pick_id = pick["id"]
            ticker = pick["ticker"]
            run_date = pick["run_date"]
            entry_price = pick["entry_price"]

            spike = index.get((ticker, run_date))
            if spike is None:
                orphan_skipped += 1
                continue
            matched += 1

            for horizon, move_col, dir_col, actual_key in [
                (3, "forecast_3d_move_pct", "forecast_3d_direction", "actual3Day"),
                (5, "forecast_5d_move_pct", "forecast_5d_direction", "actual5Day"),
                (8, "forecast_8d_move_pct", "forecast_8d_direction", "actual8Day"),
            ]:
                pred_move = pick[move_col]
                if pred_move is None:
                    continue
                pred_dir = pick[dir_col] or pick["predicted_direction"] or "UP"

                actual_move_pct = spike.get(actual_key)
                if actual_move_pct is not None:
                    actual_direction = "UP" if actual_move_pct >= 0 else "DOWN"
                    accurate = 1 if actual_direction == pred_dir else 0
                    actual_price = (
                        entry_price * (1 + actual_move_pct / 100)
                        if entry_price
                        else None
                    )
                    conn.execute(
                        """
                        INSERT OR IGNORE INTO accuracy_records
                        (pick_id, ticker, horizon_days, predicted_direction, predicted_move_pct,
                         actual_direction, actual_move_pct, actual_price, accurate, checked_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                        """,
                        (
                            pick_id,
                            ticker,
                            horizon,
                            pred_dir,
                            pred_move,
                            actual_direction,
                            round(actual_move_pct, 4),
                            actual_price,
                            accurate,
                        ),
                    )
                    resolved += 1
                else:
                    conn.execute(
                        """
                        INSERT OR IGNORE INTO accuracy_records
                        (pick_id, ticker, horizon_days, predicted_direction, predicted_move_pct)
                        VALUES (?, ?, ?, ?, ?)
                        """,
                        (pick_id, ticker, horizon, pred_dir, pred_move),
                    )
                    placeholder += 1

        conn.commit()
    except Exception as e:
        conn.rollback()
        print(f"ERROR during insert, rolled back: {e}", file=sys.stderr)
        conn.close()
        return 1

    after_total = conn.execute("SELECT COUNT(*) FROM accuracy_records").fetchone()[0]
    after_resolved = conn.execute(
        "SELECT COUNT(*) FROM accuracy_records WHERE accurate IS NOT NULL"
    ).fetchone()[0]

    print()
    print("=== RECOVERY SUMMARY ===")
    print(f"  pick_history rows processed: {len(pick_rows)}")
    print(f"  matched in Prisma dump: {matched}")
    print(f"  orphan (not in Prisma, skipped): {orphan_skipped}")
    print(f"  resolved rows inserted: {resolved}")
    print(f"  placeholder rows inserted: {placeholder}")
    print()
    print("=== accuracy_records BEFORE/AFTER ===")
    print(f"  total rows: {before_total} -> {after_total}")
    print(f"  resolved (accurate IS NOT NULL): {before_resolved} -> {after_resolved}")
    print()
    print("=== LEARNING GATE SIMULATION ===")
    for name, sql, required in [
        (
            "Gate 1 Stage Weights stage 1 (20d)",
            "SELECT COUNT(*) FROM accuracy_records ar JOIN pick_history ph ON ar.pick_id = ph.id "
            "JOIN stage_scores ss ON ss.pick_id = ph.id AND ss.stage = 1 "
            "WHERE ar.accurate IS NOT NULL AND ph.run_date >= date('now', '-20 days')",
            30,
        ),
        (
            "Gate 2 Prompt Context (15d)",
            "SELECT COUNT(*) FROM accuracy_records WHERE accurate IS NOT NULL "
            "AND checked_at >= date('now', '-15 days')",
            10,
        ),
        (
            "Gate 4 Conviction Thresholds",
            "SELECT COUNT(*) FROM accuracy_records WHERE accurate IS NOT NULL",
            50,
        ),
        (
            "Gate 5 Stage Disagreement",
            "SELECT COUNT(*) FROM stage_scores s1 JOIN stage_scores s2 "
            "ON s1.pick_id = s2.pick_id AND s1.stage < s2.stage "
            "WHERE ABS(s1.total_score - s2.total_score) > 15",
            20,
        ),
        (
            "Gate 6 Factor Feedback",
            "SELECT COUNT(*) FROM accuracy_records WHERE accurate IS NOT NULL",
            100,
        ),
        (
            "Gate 7 Adaptive Pre-Filter",
            "SELECT COUNT(*) FROM accuracy_records WHERE accurate IS NOT NULL",
            660,
        ),
    ]:
        count = conn.execute(sql).fetchone()[0]
        status = "ACTIVE" if count >= required else "waiting"
        marker = "+" if count >= required else "-"
        print(f"  {marker} {name}: {count}/{required} — {status}")

    conn.close()
    return 0


if __name__ == "__main__":
    dump_path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/spike_actuals.json"
    sys.exit(main(dump_path))
