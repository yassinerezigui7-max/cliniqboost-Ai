-- ═══════════════════════════════════════════════════════════════
-- 20260721120100_clinic_id_backfill_guard
-- Phase 3 · migration 2/6 — READ + AUDIT ONLY. Safe to re-run.
--
-- Ownership of existing rows is NOT guessed. This migration scans every
-- tenant table for rows with NULL clinic_id and records them in
-- `needs_manual_review`. It writes NOTHING to the tenant tables and deletes
-- nothing. Migration 3 (SET NOT NULL) refuses to run while any such row
-- exists, so this is the safety gate in front of it.
--
-- As of the Phase-1 audit there are ZERO NULL clinic_id rows, so this is
-- expected to record nothing — but it stays in the pipeline so a re-run after
-- new data is still safe.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS needs_manual_review (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name   TEXT NOT NULL,
  row_id       UUID,
  reason       TEXT NOT NULL,
  detected_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Re-runnable: clear prior null_clinic_id findings, then re-detect.
DELETE FROM needs_manual_review WHERE reason = 'null_clinic_id';

DO $$
DECLARE
  t   TEXT;
  tables TEXT[] := ARRAY[
    'contacts','conversations','messages','missed_calls','appointments',
    'revenue_metrics','touch_schedule','waitlist','onboarding_submissions',
    'provisioning_jobs','integration_tasks','lead_sources','import_jobs'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format(
      'INSERT INTO needs_manual_review (table_name, row_id, reason)
         SELECT %L, id, ''null_clinic_id'' FROM %I WHERE clinic_id IS NULL',
      t, t
    );
  END LOOP;
END $$;

-- Surface the result to the migration log.
DO $$
DECLARE n BIGINT;
BEGIN
  SELECT count(*) INTO n FROM needs_manual_review WHERE reason = 'null_clinic_id';
  RAISE NOTICE 'clinic_id backfill guard: % row(s) need manual review', n;
END $$;
