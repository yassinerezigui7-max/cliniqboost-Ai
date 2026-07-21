-- ═══════════════════════════════════════════════════════════════
-- 20260721120500_app_tenant_role
-- Phase 3 · migration 6/6 — LEAST-PRIVILEGE ROLE. Safe to re-run.
--
-- Creates `app_tenant`: a NOLOGIN, SELECT-only role for the planned per-clinic
-- dashboard read path. It does NOT have BYPASSRLS, so the tenant_isolation
-- policy (migration 5) fully applies to it. Combined with a per-request
--   SELECT set_config('app.current_clinic_id', '<uuid>', true);
-- the DATABASE enforces one-clinic scoping for dashboard reads — the concrete
-- "second layer, not the only layer" (ARCHITECTURE_PROPOSAL §3).
--
-- Wiring the dashboard read path to actually SET ROLE app_tenant + set the
-- session var is Phase 5 (backend) work; this migration only provisions the
-- role and its grants. Creating it changes nothing about the current
-- service_role-based app. No data is modified.
-- ═══════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN
    CREATE ROLE app_tenant NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO app_tenant;

-- SELECT-only on every tenant table. (No INSERT/UPDATE/DELETE: the dashboard
-- reads; all writes stay on the service_role backend.)
DO $$
DECLARE
  t   TEXT;
  tables TEXT[] := ARRAY[
    'clinics','contacts','conversations','messages','missed_calls','appointments',
    'revenue_metrics','touch_schedule','waitlist','clinic_config',
    'onboarding_submissions','provisioning_jobs','integration_tasks',
    'lead_sources','import_jobs'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('GRANT SELECT ON %I TO app_tenant', t);
  END LOOP;
END $$;

-- Allow the backend's connecting roles to assume app_tenant (SET ROLE).
-- Supabase pooler connects as `authenticator`; direct admin is `postgres`.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    EXECUTE 'GRANT app_tenant TO authenticator';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT app_tenant TO service_role';
  END IF;
END $$;
