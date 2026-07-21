-- ═══════════════════════════════════════════════════════════════
-- 20260721120300_tenant_indexes
-- Phase 3 · migration 4/6 — ADDITIVE INDEXES ONLY. Safe to re-run.
--
-- Fills the clinic_id index gaps (messages, revenue_metrics) and adds
-- (clinic_id, created_at) / (clinic_id, status) composites for the dashboard's
-- tenant-scoped, time-windowed queries. No index is dropped.
--
-- ⚠ EXECUTION NOTE: CREATE INDEX CONCURRENTLY CANNOT run inside a transaction
--    block. Run this file OUTSIDE a transaction:
--      psql "$DATABASE_URL" -f 20260721120300_tenant_indexes.sql
--    or `supabase db push --single-transaction=false` (per your CLI version).
--    At current data volume (<50 rows/table) a plain CREATE INDEX is equally
--    safe; CONCURRENTLY is used so the same file stays lock-free at scale.
-- ═══════════════════════════════════════════════════════════════

-- Gap fills (single-column clinic_id where missing).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_clinic        ON messages(clinic_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_revenue_metrics_clinic ON revenue_metrics(clinic_id);

-- Dashboard composites: filter by clinic_id, order/window by created_at.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_clinic_created     ON messages(clinic_id, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_missed_calls_clinic_created ON missed_calls(clinic_id, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_appointments_clinic_created ON appointments(clinic_id, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_clinic_created     ON contacts(clinic_id, created_at DESC);

-- Appointment reminder/no-show sweeps filter by clinic_id + status.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_appointments_clinic_status  ON appointments(clinic_id, status);
