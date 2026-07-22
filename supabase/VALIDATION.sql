-- ═══════════════════════════════════════════════════════════════
-- Phase 4 validation — run in the Supabase SQL Editor AFTER applying all
-- six migrations. Read-only: SELECTs only, nothing is modified.
-- Paste the full output back and I'll confirm the tenant-isolation guarantees.
-- ═══════════════════════════════════════════════════════════════

-- ── PROOF 1: zero rows with NULL clinic_id on every tenant table ──
-- Every `nulls` value MUST be 0.
SELECT 'contacts'               AS tbl, count(*) FILTER (WHERE clinic_id IS NULL) AS nulls, count(*) AS rows FROM contacts
UNION ALL SELECT 'conversations',          count(*) FILTER (WHERE clinic_id IS NULL), count(*) FROM conversations
UNION ALL SELECT 'messages',               count(*) FILTER (WHERE clinic_id IS NULL), count(*) FROM messages
UNION ALL SELECT 'missed_calls',           count(*) FILTER (WHERE clinic_id IS NULL), count(*) FROM missed_calls
UNION ALL SELECT 'appointments',           count(*) FILTER (WHERE clinic_id IS NULL), count(*) FROM appointments
UNION ALL SELECT 'revenue_metrics',        count(*) FILTER (WHERE clinic_id IS NULL), count(*) FROM revenue_metrics
UNION ALL SELECT 'touch_schedule',         count(*) FILTER (WHERE clinic_id IS NULL), count(*) FROM touch_schedule
UNION ALL SELECT 'waitlist',               count(*) FILTER (WHERE clinic_id IS NULL), count(*) FROM waitlist
UNION ALL SELECT 'onboarding_submissions', count(*) FILTER (WHERE clinic_id IS NULL), count(*) FROM onboarding_submissions
UNION ALL SELECT 'provisioning_jobs',      count(*) FILTER (WHERE clinic_id IS NULL), count(*) FROM provisioning_jobs
UNION ALL SELECT 'integration_tasks',      count(*) FILTER (WHERE clinic_id IS NULL), count(*) FROM integration_tasks
UNION ALL SELECT 'lead_sources',           count(*) FILTER (WHERE clinic_id IS NULL), count(*) FROM lead_sources
UNION ALL SELECT 'import_jobs',            count(*) FILTER (WHERE clinic_id IS NULL), count(*) FROM import_jobs
ORDER BY nulls DESC, tbl;

-- ── PROOF 2: clinic_id is NOT NULL on every tenant table ──
-- is_nullable MUST be 'NO' for all rows.
SELECT table_name, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND column_name = 'clinic_id'
  AND table_name IN ('contacts','conversations','messages','missed_calls','appointments',
    'revenue_metrics','touch_schedule','waitlist','clinic_config','onboarding_submissions',
    'provisioning_jobs','integration_tasks','lead_sources','import_jobs')
ORDER BY is_nullable DESC, table_name;

-- ── PROOF 3: RLS enabled AND forced on every tenant table ──
-- rls_enabled AND rls_forced MUST both be true for all 14 rows.
SELECT relname AS tbl, relrowsecurity AS rls_enabled, relforcerowsecurity AS rls_forced
FROM pg_class
WHERE relnamespace = 'public'::regnamespace
  AND relname IN ('contacts','conversations','messages','missed_calls','appointments',
    'revenue_metrics','touch_schedule','waitlist','clinic_config','onboarding_submissions',
    'provisioning_jobs','integration_tasks','lead_sources','import_jobs')
ORDER BY rls_enabled, rls_forced, tbl;

-- ── PROOF 4: NO policy uses USING (true) anywhere in public ──
-- MUST return 0 rows.
SELECT tablename, policyname, qual
FROM pg_policies
WHERE schemaname = 'public' AND qual = 'true';

-- ── PROOF 5: every tenant table has exactly the tenant_isolation policy ──
-- Each table should show tenant_isolation with a clinic_id = ... predicate.
SELECT tablename, policyname, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;

-- ── PROOF 6: app_tenant role exists, cannot log in, does NOT bypass RLS ──
-- Expect: rolcanlogin=false, rolbypassrls=false.
SELECT rolname, rolcanlogin, rolbypassrls
FROM pg_roles WHERE rolname = 'app_tenant';

-- ── PROOF 7: new clinics business columns exist ──
-- Expect 4 rows: subscription_status, plan, go_live_at, twilio_number_sid.
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'clinics'
  AND column_name IN ('subscription_status','plan','go_live_at','twilio_number_sid')
ORDER BY column_name;

-- ── PROOF 8: any rows flagged for manual review (should be empty) ──
SELECT table_name, count(*) FROM needs_manual_review
WHERE reason = 'null_clinic_id' GROUP BY table_name;
