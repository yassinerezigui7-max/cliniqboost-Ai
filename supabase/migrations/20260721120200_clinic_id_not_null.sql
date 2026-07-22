-- ═══════════════════════════════════════════════════════════════
-- 20260721120200_clinic_id_not_null
-- Phase 3 · migration 3/6 — CONSTRAINT ONLY. Safe to re-run.
--
-- Promotes clinic_id to NOT NULL on every tenant table. The inline FK to
-- clinics(id) already exists and is enforced (created with the tables); this
-- adds the missing NOT NULL so an orphan (clinic-less) row can never be
-- written again.
--
-- GUARDED: for each table, if ANY row still has NULL clinic_id the statement
-- RAISEs and aborts WITHOUT altering the column — run migration 2 and resolve
-- needs_manual_review first. No data is modified or deleted here.
--
-- clinic_config is intentionally omitted: its clinic_id is the PRIMARY KEY and
-- is therefore already NOT NULL.
-- ═══════════════════════════════════════════════════════════════

DO $$
DECLARE
  t   TEXT;
  n   BIGINT;
  tables TEXT[] := ARRAY[
    'contacts','conversations','messages','missed_calls','appointments',
    'revenue_metrics','touch_schedule','waitlist','onboarding_submissions',
    'provisioning_jobs','integration_tasks','lead_sources','import_jobs'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE clinic_id IS NULL', t) INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION
        '% has % row(s) with NULL clinic_id — aborting SET NOT NULL. Resolve needs_manual_review first.',
        t, n;
    END IF;
    -- No-op if already NOT NULL; sets it otherwise.
    EXECUTE format('ALTER TABLE %I ALTER COLUMN clinic_id SET NOT NULL', t);
    RAISE NOTICE 'clinic_id SET NOT NULL on %', t;
  END LOOP;
END $$;
