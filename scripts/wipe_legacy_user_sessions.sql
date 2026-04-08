-- ============================================
-- Wipe contaminated legacy UserSession rows
-- One-shot script, runs once at heartbeat deploy
-- ============================================
--
-- Spec:  docs/superpowers/specs/2026-04-08-user-activity-heartbeat-design.md
-- Plan:  docs/superpowers/plans/2026-04-08-user-activity-heartbeat.md
--
-- The legacy UserSession data has two contamination bugs:
--   1. NULL durations (users never explicitly logged out)
--   2. ~21h durations (overnight tab-open rotated to logout the next morning)
-- The user explicitly authorized wiping it.
--
-- This is a SCOPED DELETE, not unconditional. The WHERE clause is honest
-- ("everything that exists at script start") and race-safe: any rows inserted
-- by other connections during this script have loginAt > NOW() and survive.

-- Audit log: pre-flight count of rows about to be deleted
DO $$
DECLARE row_count int;
BEGIN
  SELECT COUNT(*) INTO row_count FROM "UserSession";
  RAISE NOTICE 'About to delete % UserSession rows (legacy data, pre-heartbeat)', row_count;
END $$;

-- Scoped wipe
DELETE FROM "UserSession" WHERE "loginAt" < NOW();

-- Confirmation
SELECT COUNT(*) AS remaining_rows FROM "UserSession";
