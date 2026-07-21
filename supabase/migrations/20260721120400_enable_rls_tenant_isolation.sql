-- ═══════════════════════════════════════════════════════════════
-- 20260721120400_enable_rls_tenant_isolation
-- Phase 3 · migration 5/6 — SECURITY. Safe to re-run (drop-then-create).
--
-- Enables + FORCEs RLS on every tenant table and installs one deny-by-default
-- tenant-isolation policy per table (ARCHITECTURE_PROPOSAL §3, Option B).
--
-- Effect on the running app: NONE. The Railway backend uses the service_role
-- key, which has BYPASSRLS — it is unaffected. RLS here is defense-in-depth
-- that constrains every OTHER connection (anon key, the app_tenant dashboard
-- role in migration 6, and the future Option-A auth path).
--
-- Also removes the `dashboard anon read` USING(true) policies (the public-anon
-- PII footgun from supabase/dashboard-rls-policies.sql), if present.
--
-- The policy predicate reads a per-request session variable set by the backend:
--   SELECT set_config('app.current_clinic_id', '<clinic-uuid>', true);
-- and is written so Option A (JWT claim) is a later one-line predicate swap.
-- No table or column is dropped. No data is modified.
-- ═══════════════════════════════════════════════════════════════

DO $$
DECLARE
  t   TEXT;
  tables TEXT[] := ARRAY[
    'contacts','conversations','messages','missed_calls','appointments',
    'revenue_metrics','touch_schedule','waitlist','clinic_config',
    'onboarding_submissions','provisioning_jobs','integration_tasks',
    'lead_sources','import_jobs'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    -- Remove the public-anon read footgun if it was ever applied.
    EXECUTE format('DROP POLICY IF EXISTS "dashboard anon read" ON %I', t);

    -- (Re)create the single tenant-isolation policy. Deny-by-default: when the
    -- session var is unset the predicate is NULL → zero rows. NULLIF guards the
    -- empty-string cast. WITH CHECK blocks cross-tenant writes symmetrically.
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING      (clinic_id = NULLIF(current_setting('app.current_clinic_id', true), '')::uuid)
        WITH CHECK (clinic_id = NULLIF(current_setting('app.current_clinic_id', true), '')::uuid)
    $f$, t);

    RAISE NOTICE 'RLS forced + tenant_isolation policy on %', t;
  END LOOP;
END $$;
