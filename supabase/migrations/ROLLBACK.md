# Rollback — Phase 3 multi-tenant migrations

Reversal notes for each migration in this directory. These migrations are
**non-destructive** (no `DROP TABLE` / `DROP COLUMN` / `TRUNCATE`), so "rollback"
means relaxing constraints / removing added objects, never restoring lost data.

Run reversals in **reverse order** (6 → 1) if undoing the whole set. Each block is
idempotent and safe to re-run. **Nothing here has been applied yet** — this is
review material for Phase 4.

> None of these reversals delete tenant data. The only data ever written by the
> forward set is: `clinics` column backfills (values, not rows) and rows in the
> `needs_manual_review` audit table.

---

## 6/6 — `20260721120500_app_tenant_role`

```sql
-- Revoke grants, then drop the role. REVOKE before DROP or DROP errors.
DO $$
DECLARE t TEXT;
  tables TEXT[] := ARRAY['clinics','contacts','conversations','messages','missed_calls',
    'appointments','revenue_metrics','touch_schedule','waitlist','clinic_config',
    'onboarding_submissions','provisioning_jobs','integration_tasks','lead_sources','import_jobs'];
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_tenant') THEN
    FOREACH t IN ARRAY tables LOOP
      EXECUTE format('REVOKE SELECT ON %I FROM app_tenant', t);
    END LOOP;
    REVOKE USAGE ON SCHEMA public FROM app_tenant;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticator') THEN EXECUTE 'REVOKE app_tenant FROM authenticator'; END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role')  THEN EXECUTE 'REVOKE app_tenant FROM service_role';  END IF;
    DROP ROLE app_tenant;
  END IF;
END $$;
```

## 5/6 — `20260721120400_enable_rls_tenant_isolation`

```sql
-- Drop the tenant_isolation policy and disable RLS per table.
-- ⚠ This REOPENS the tables to any non-BYPASSRLS role that has grants. Only do
--   this deliberately. The `dashboard anon read` policy is NOT recreated
--   (it was a footgun); recreate manually only if you truly need it.
DO $$
DECLARE t TEXT;
  tables TEXT[] := ARRAY['contacts','conversations','messages','missed_calls','appointments',
    'revenue_metrics','touch_schedule','waitlist','clinic_config','onboarding_submissions',
    'provisioning_jobs','integration_tasks','lead_sources','import_jobs'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
    -- NOTE: the onboarding tables (onboarding_submissions, provisioning_jobs,
    -- integration_tasks, lead_sources, import_jobs, clinic_config) had RLS
    -- ENABLED by supabase/onboarding-schema.sql BEFORE this migration. Leaving
    -- RLS enabled on them matches their original state. Only DISABLE RLS on the
    -- core tables if you want to return to the pre-Phase-3 (repo) state:
    -- EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
```

## 4/6 — `20260721120300_tenant_indexes`

```sql
-- Drop the added indexes (CONCURRENTLY, outside a transaction).
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_clinic;
DROP INDEX CONCURRENTLY IF EXISTS idx_revenue_metrics_clinic;
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_clinic_created;
DROP INDEX CONCURRENTLY IF EXISTS idx_missed_calls_clinic_created;
DROP INDEX CONCURRENTLY IF EXISTS idx_appointments_clinic_created;
DROP INDEX CONCURRENTLY IF EXISTS idx_contacts_clinic_created;
DROP INDEX CONCURRENTLY IF EXISTS idx_appointments_clinic_status;
```

## 3/6 — `20260721120200_clinic_id_not_null`

```sql
-- Relax clinic_id back to nullable on every tenant table (FK stays intact).
DO $$
DECLARE t TEXT;
  tables TEXT[] := ARRAY['contacts','conversations','messages','missed_calls','appointments',
    'revenue_metrics','touch_schedule','waitlist','onboarding_submissions','provisioning_jobs',
    'integration_tasks','lead_sources','import_jobs'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN clinic_id DROP NOT NULL', t);
  END LOOP;
END $$;
```

## 2/6 — `20260721120100_clinic_id_backfill_guard`

```sql
-- Remove the audit rows this migration inserted. Drop the table only if you
-- also rolled back everything that might reference it (nothing does today).
DELETE FROM needs_manual_review WHERE reason = 'null_clinic_id';
-- DROP TABLE IF EXISTS needs_manual_review;   -- optional; audit table only
```

## 1/6 — `20260721120000_clinics_tenant_columns`

```sql
-- Reversing the backfill values is lossy for subscription_status/plan intent,
-- so prefer to LEAVE the columns in place. If you must fully revert:
ALTER TABLE clinics DROP CONSTRAINT IF EXISTS clinics_subscription_status_chk;
-- (Column drops are destructive of any values entered since — do this only if
--  you are certain nothing depends on these columns.)
-- ALTER TABLE clinics DROP COLUMN IF EXISTS twilio_number_sid;
-- ALTER TABLE clinics DROP COLUMN IF EXISTS go_live_at;
-- ALTER TABLE clinics DROP COLUMN IF EXISTS plan;
-- ALTER TABLE clinics DROP COLUMN IF EXISTS subscription_status;
```
