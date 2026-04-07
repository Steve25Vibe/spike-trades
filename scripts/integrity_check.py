"""Daily integrity check for the Spike Trades council SQLite database.

Compares current row counts against expected MIN thresholds for every
critical table. Designed to catch the kind of silent wipe damage that
hit calibration_base_rates / accuracy_records on Apr 6.

Run via: docker exec spike-trades-council python3 /app/scripts/integrity_check.py
Exit code: 0 if all checks pass, 1 if any threshold violated.

Adding a new table to monitor:
  1. Add (table_name, min_rows, description) to CHECKS below
  2. Set min_rows below the LOWEST sane production value
  3. The check will alert if the count ever falls below that floor

Adjusting thresholds:
  After legitimate maintenance that drops a count, update CHECKS to
  reflect the new floor. Don't set min_rows = 0 (defeats the purpose).
"""

import sys
import sqlite3
from datetime import datetime, timezone

DB_PATH = "/app/data/spike_trades_council.db"

# (table_name, min_rows, description)
# Thresholds chosen below current production values with safety margin.
# If a table count drops below its threshold, the check fails — meaning
# something deleted data that shouldn't have been deleted.
CHECKS = [
    ("calibration_base_rates", 200,
     "Backtest-derived RSI/MACD/ADX/volume bucket base rates. Wipe → Today's Spikes History bars all NULL."),
    ("calibration_council", 20,
     "Council confidence-bucket calibration. Wipe → no council blending in apply_calibration."),
    ("accuracy_records", 250,
     "Per-pick × per-horizon outcome records. Wipe → all learning gates fail."),
    ("pick_history", 100,
     "Council pick history backbone. Wipe → no learning data, no Stage analytics."),
    ("stage_scores", 300,
     "Per-stage LLM scores. Wipe → Gate 1 (stage weights) and disagreement gates fail."),
    ("portfolio_state", 1,
     "User portfolio cash/sizing state. Wipe → users lose portfolio settings."),
    ("roadmap_history", 1,
     "Daily roadmap entries. Wipe → roadmap history erased."),
]


def main() -> int:
    timestamp = datetime.now(timezone.utc).isoformat()
    print(f"[{timestamp}] Integrity check on {DB_PATH}")
    print("=" * 76)

    try:
        conn = sqlite3.connect(DB_PATH)
    except Exception as e:
        print(f"  ✗ FAILED to open database: {e}")
        return 1

    failed = []
    warned = []
    passed = []

    print(f"  {'TABLE':<28} {'CURRENT':>10} {'MIN':>8} {'STATUS':<10}")
    print("  " + "-" * 60)

    for table, min_rows, description in CHECKS:
        try:
            count = conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
        except sqlite3.OperationalError as e:
            print(f"  {table:<28} {'?':>10} {min_rows:>8} ✗ MISSING TABLE: {e}")
            failed.append((table, "missing", description))
            continue

        if count < min_rows:
            status = "✗ FAIL"
            failed.append((table, count, description))
        elif count < min_rows * 1.2:
            status = "⚠ WARN"
            warned.append((table, count, description))
        else:
            status = "✓ OK"
            passed.append((table, count))

        print(f"  {table:<28} {count:>10} {min_rows:>8} {status}")

    print("  " + "-" * 60)

    # Check sqlite_sequence for hidden wipes (current << seq)
    print()
    print("  [sqlite_sequence drift check (current vs all-time high)]")
    try:
        for table, min_rows, _ in CHECKS:
            seq_row = conn.execute(
                "SELECT seq FROM sqlite_sequence WHERE name = ?", (table,)
            ).fetchone()
            if seq_row is None:
                continue
            seq = seq_row[0]
            current = conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
            # Don't alert for tables that legitimately use INSERT OR REPLACE
            # (calibration_council reuses keys, so seq grows but row count stays low)
            if table == "calibration_council":
                continue
            if seq > 0 and current < seq * 0.3:
                drift_pct = (1 - current / seq) * 100
                print(f"    ⚠ {table}: current={current}, all-time={seq}  ({drift_pct:.0f}% loss vs high-water)")
                warned.append((table, f"drift {drift_pct:.0f}%", "row count is significantly below historical high"))
    except Exception as e:
        print(f"    (sequence check skipped: {e})")

    conn.close()

    print()
    print("=" * 76)
    print(f"  PASSED: {len(passed)}   WARNED: {len(warned)}   FAILED: {len(failed)}")
    print("=" * 76)

    if failed:
        print()
        print("  FAILURES (immediate attention required):")
        for table, count, description in failed:
            print(f"    ✗ {table}: {count}")
            print(f"      → {description}")
        return 1

    if warned:
        print()
        print("  WARNINGS (monitor):")
        for table, count, description in warned:
            print(f"    ⚠ {table}: {count}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
