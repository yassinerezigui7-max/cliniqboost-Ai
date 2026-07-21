-- ═══════════════════════════════════════════════════════════════
-- 20260721120000_clinics_tenant_columns
-- Phase 3 · migration 1/6 — ADDITIVE ONLY. Safe to re-run.
--
-- Adds business/tenant-root columns to `clinics` (see ARCHITECTURE_PROPOSAL §1).
-- No column is dropped or narrowed. No data is deleted.
--
-- subscription_status is a SEPARATE axis from onboarding_status (provisioning
-- lifecycle) and is_active (runtime routing gate). Do NOT conflate them.
-- ═══════════════════════════════════════════════════════════════

-- New columns (all additive; defaulted or nullable).
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS subscription_status TEXT NOT NULL DEFAULT 'trial';
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS plan TEXT;
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS go_live_at TIMESTAMPTZ;
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS twilio_number_sid TEXT;

-- Constrain the allowed values (idempotent: drop-if-exists then add).
ALTER TABLE clinics DROP CONSTRAINT IF EXISTS clinics_subscription_status_chk;
ALTER TABLE clinics ADD  CONSTRAINT clinics_subscription_status_chk
  CHECK (subscription_status IN ('trial','active','paused','churned'));

-- Backfill: the clinics that existed BEFORE this migration are operational,
-- not trials. Cutoff = this migration's authoring time, so re-runs are no-ops
-- and genuinely-new trial clinics (created after) are never clobbered.
UPDATE clinics
   SET subscription_status = 'active'
 WHERE subscription_status = 'trial'
   AND created_at < TIMESTAMPTZ '2026-07-21 12:00:00+00';

-- Optional backfill: stamp go_live_at for already-live clinics that never had
-- one recorded (uses provisioned_at, else created_at). Idempotent.
UPDATE clinics
   SET go_live_at = COALESCE(provisioned_at, created_at)
 WHERE is_active = true
   AND onboarding_status = 'live'
   AND go_live_at IS NULL;
