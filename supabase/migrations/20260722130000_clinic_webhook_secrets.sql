-- ═══════════════════════════════════════════════════════════════
-- 20260722130000_clinic_webhook_secrets
-- M2 fix (scoped Option A) — per-clinic webhook secrets. ADDITIVE, safe to re-run.
--
-- Purpose: make the *secret* the tenant identity for /webhooks/new-lead, so a
-- caller can only act as the clinic whose secret it holds — instead of a single
-- shared secret + a caller-asserted clinic_id.
--
-- Design: a DEDICATED table (not a column on `clinics`) so the secret is never
-- exposed to anything that reads the clinics row — in particular the
-- least-privilege `app_tenant` dashboard role, which was granted SELECT on
-- `clinics` in 20260721120500. Only the service_role backend (BYPASSRLS) reads
-- this table.
--
-- Rollback: DROP TRIGGER trg_ensure_clinic_secret ON clinics;
--           DROP FUNCTION ensure_clinic_secret();
--           DROP TABLE clinic_secrets;   -- destructive of the secrets only
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS clinic_secrets (
  clinic_id      UUID PRIMARY KEY REFERENCES clinics(id) ON DELETE CASCADE,
  -- 256 bits of randomness (two v4 UUIDs, dashes stripped). gen_random_uuid()
  -- is already the PK default across the schema, so no pgcrypto dependency.
  webhook_secret TEXT NOT NULL UNIQUE
    DEFAULT (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at     TIMESTAMPTZ
);

-- RLS deny-by-default. No policy is created and no grant is given to app_tenant,
-- so only the service_role (which bypasses RLS) can read/write secrets.
ALTER TABLE clinic_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinic_secrets FORCE ROW LEVEL SECURITY;

-- Backfill: issue a secret for every existing clinic (the DEFAULT generates it).
INSERT INTO clinic_secrets (clinic_id)
  SELECT id FROM clinics
  ON CONFLICT (clinic_id) DO NOTHING;

-- Auto-issue for every future clinic, on ANY insert path (RPC, manual, import),
-- without modifying create_clinic_onboarding.
CREATE OR REPLACE FUNCTION ensure_clinic_secret()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  INSERT INTO clinic_secrets (clinic_id) VALUES (NEW.id)
  ON CONFLICT (clinic_id) DO NOTHING;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_ensure_clinic_secret ON clinics;
CREATE TRIGGER trg_ensure_clinic_secret
  AFTER INSERT ON clinics
  FOR EACH ROW EXECUTE FUNCTION ensure_clinic_secret();
