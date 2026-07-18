-- ═══════════════════════════════════════════════════════════════
-- Automatic Clinic Onboarding — schema (Phase 0)
--
-- Run ONCE in the Supabase SQL Editor. Written idempotently
-- (IF NOT EXISTS / CREATE OR REPLACE) so it's safe to re-run.
-- Additive only: no existing column is dropped or narrowed.
--
-- Prerequisite: pillar2-schema.sql and subsystem5-waitlist.sql must
-- already be applied (touch_schedule, waitlist).
-- ═══════════════════════════════════════════════════════════════

-- ── clinics: new columns ──────────────────────────────────────
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS slug TEXT;
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS onboarding_status TEXT DEFAULT 'live';
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS enabled_subsystems JSONB;
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS booking_software_status TEXT DEFAULT 'none';
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS provisioned_at TIMESTAMPTZ;

-- onboarding_status lifecycle:
--   created → awaiting_number → provisioning → ready → live  (+ provisioning_failed)
-- Existing rows default to 'live' (they were created manually and are already
-- routing). New rows are inserted with 'created' by the RPC below.

-- Onboarded clinics have no number until Twilio provisioning completes, so
-- phone_number must allow NULL. Widening only — existing rows are untouched,
-- and getClinicByPhone matches on phone_number = <twilio number>, which a
-- NULL row can never satisfy, so inbound routing is unaffected.
ALTER TABLE clinics ALTER COLUMN phone_number DROP NOT NULL;

-- Hard backstops for idempotent onboarding.
-- ⚠️ These fail if duplicate emails/slugs already exist — check first with:
--   SELECT lower(email), count(*) FROM clinics GROUP BY 1 HAVING count(*) > 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_clinics_email_unique
  ON clinics (lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_clinics_slug_unique
  ON clinics (slug) WHERE slug IS NOT NULL;

-- ── clinic_config ─────────────────────────────────────────────
-- Per-clinic operational settings, 1:1 with clinics, kept off the hot row.
CREATE TABLE IF NOT EXISTS clinic_config (
  clinic_id UUID PRIMARY KEY REFERENCES clinics(id),
  business_hours JSONB DEFAULT '{}'::jsonb,   -- {"mon":{"open":"09:00","close":"18:00","closed":false},...}
  quiet_hours JSONB DEFAULT '{}'::jsonb,      -- {"start":"20:00","end":"09:00"}
  lead_settings JSONB DEFAULT '{}'::jsonb,    -- ads/access flags from intake
  scheduler_settings JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── onboarding_submissions ────────────────────────────────────
-- Raw intake payload: audit trail + replay source of truth.
CREATE TABLE IF NOT EXISTS onboarding_submissions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  clinic_id UUID REFERENCES clinics(id),
  raw_payload JSONB NOT NULL,
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── provisioning_jobs ─────────────────────────────────────────
-- Async post-commit provisioning state machine; driven by the retry cron.
CREATE TABLE IF NOT EXISTS provisioning_jobs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  clinic_id UUID REFERENCES clinics(id),
  status TEXT DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'done', 'failed')),
  attempts INTEGER DEFAULT 0,
  last_error TEXT,
  next_attempt_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── integration_tasks ─────────────────────────────────────────
-- Pending human/credential steps that block a clinic short of 'ready'.
CREATE TABLE IF NOT EXISTS integration_tasks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  clinic_id UUID REFERENCES clinics(id),
  type TEXT NOT NULL
    CHECK (type IN ('twilio_number', 'vagaro_connect', 'csv_pending')),
  status TEXT DEFAULT 'pending'
    CHECK (status IN ('pending', 'waiting_for_credentials', 'done', 'failed')),
  payload JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── lead_sources ──────────────────────────────────────────────
-- Maps an inbound lead's source id (Meta page, Google form, web form) to a
-- clinic, so the two n8n ingress workflows stay clinic-agnostic.
CREATE TABLE IF NOT EXISTS lead_sources (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  clinic_id UUID REFERENCES clinics(id),
  channel TEXT NOT NULL CHECK (channel IN ('meta', 'google', 'web', 'vagaro')),
  external_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (channel, external_id)
);

-- ── import_jobs ───────────────────────────────────────────────
-- CSV/API contact-import tracking + per-row failure report.
CREATE TABLE IF NOT EXISTS import_jobs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  clinic_id UUID REFERENCES clinics(id),
  source TEXT DEFAULT 'csv' CHECK (source IN ('csv', 'api')),
  status TEXT DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'done', 'failed')),
  rows_total INTEGER DEFAULT 0,
  rows_ok INTEGER DEFAULT 0,
  rows_failed INTEGER DEFAULT 0,
  report JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── indexes ───────────────────────────────────────────────────
-- Retry-cron hot path: due pending jobs.
CREATE INDEX IF NOT EXISTS idx_provisioning_jobs_due
  ON provisioning_jobs (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_provisioning_jobs_clinic ON provisioning_jobs (clinic_id);
CREATE INDEX IF NOT EXISTS idx_integration_tasks_clinic ON integration_tasks (clinic_id);
CREATE INDEX IF NOT EXISTS idx_lead_sources_clinic ON lead_sources (clinic_id);
CREATE INDEX IF NOT EXISTS idx_import_jobs_clinic ON import_jobs (clinic_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_submissions_clinic ON onboarding_submissions (clinic_id);

-- ── RLS ───────────────────────────────────────────────────────
-- Deny-by-default for the anon key: RLS enabled, no anon policies. The
-- Railway service key bypasses RLS, which is the only intended writer/reader.
ALTER TABLE clinic_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE provisioning_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_jobs ENABLE ROW LEVEL SECURITY;

-- ── RPC: create_clinic_onboarding ─────────────────────────────
-- The ONLY place a clinic is born. One transaction: clinics + clinic_config +
-- onboarding_submissions + integration_tasks + provisioning_jobs commit
-- together or not at all. Idempotent on email — an existing clinic with the
-- same email is returned, never duplicated.
--
-- Expected p_payload (produced by services/validation.js):
-- {
--   "clinic_name": "...", "legal_name": "...", "email": "...",
--   "owner_phone": "+1...", "clinic_phone": "+1..." | null,
--   "city": "...", "country": "...", "timezone": "America/New_York",
--   "services": "Botox, Filler", "hero_service": "...",
--   "avg_service_price": 0, "booking_link": "..." | null,
--   "booking_software": "vagaro", "booking_software_raw": "Vagaro",
--   "business_hours": {...}, "quiet_hours": {...}, "lead_settings": {...},
--   "idempotency_key": "...", "raw": { original form body }
-- }
CREATE OR REPLACE FUNCTION create_clinic_onboarding(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email     TEXT := lower(trim(p_payload->>'email'));
  v_name      TEXT := trim(coalesce(p_payload->>'clinic_name', ''));
  v_booking   TEXT := lower(coalesce(p_payload->>'booking_software', 'other'));
  v_existing  RECORD;
  v_clinic_id UUID;
  v_base_slug TEXT;
  v_slug      TEXT;
  v_n         INTEGER := 0;
BEGIN
  IF v_email IS NULL OR v_email = '' THEN
    RAISE EXCEPTION 'email is required';
  END IF;
  IF v_name = '' THEN
    RAISE EXCEPTION 'clinic_name is required';
  END IF;

  -- Idempotency: same email → return the existing clinic, write nothing.
  SELECT id, slug, onboarding_status INTO v_existing
    FROM clinics WHERE lower(email) = v_email LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'clinic_id', v_existing.id,
      'slug', v_existing.slug,
      'onboarding_status', coalesce(v_existing.onboarding_status, 'live'),
      'existing', true
    );
  END IF;

  -- URL-safe unique slug from the clinic name.
  v_base_slug := trim(both '-' from regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g'));
  IF v_base_slug = '' THEN v_base_slug := 'clinic'; END IF;
  v_slug := v_base_slug;
  WHILE EXISTS (SELECT 1 FROM clinics WHERE slug = v_slug) LOOP
    v_n := v_n + 1;
    v_slug := v_base_slug || '-' || v_n;
  END LOOP;

  -- 1/5 clinics — born inactive; is_active is the live gate.
  INSERT INTO clinics (
    name, email, phone_number, software, city, country, timezone,
    services, avg_service_price, booking_link, greeting, is_active,
    slug, onboarding_status, enabled_subsystems, booking_software_status
  ) VALUES (
    v_name,
    v_email,
    NULL,
    coalesce(p_payload->>'booking_software_raw', v_booking),
    p_payload->>'city',
    p_payload->>'country',
    coalesce(p_payload->>'timezone', 'UTC'),
    coalesce(p_payload->>'services', ''),
    coalesce((p_payload->>'avg_service_price')::numeric, 0),
    p_payload->>'booking_link',
    'Hi! Thanks for reaching out to ' || v_name || '.',
    false,
    v_slug,
    'created',
    coalesce(p_payload->'enabled_subsystems', '{"missed_call":true,"nurture":true,"noshow":true,"dormant":true,"waitlist":true,"vip":true}'::jsonb),
    CASE WHEN v_booking = 'vagaro' THEN 'waiting_for_credentials' ELSE 'none' END
  ) RETURNING id INTO v_clinic_id;

  -- 2/5 clinic_config
  INSERT INTO clinic_config (clinic_id, business_hours, quiet_hours, lead_settings, scheduler_settings)
  VALUES (
    v_clinic_id,
    coalesce(p_payload->'business_hours', '{}'::jsonb),
    coalesce(p_payload->'quiet_hours', '{}'::jsonb),
    coalesce(p_payload->'lead_settings', '{}'::jsonb),
    '{}'::jsonb
  );

  -- 3/5 raw submission (audit + replay)
  INSERT INTO onboarding_submissions (clinic_id, raw_payload, idempotency_key)
  VALUES (v_clinic_id, p_payload, coalesce(p_payload->>'idempotency_key', v_email));

  -- 4/5 pending credential/provisioning tasks
  INSERT INTO integration_tasks (clinic_id, type, status)
  VALUES (v_clinic_id, 'twilio_number', 'pending');
  IF v_booking = 'vagaro' THEN
    INSERT INTO integration_tasks (clinic_id, type, status)
    VALUES (v_clinic_id, 'vagaro_connect', 'waiting_for_credentials');
  END IF;

  -- 5/5 provisioning job (picked up post-commit by services/provisioning.js)
  INSERT INTO provisioning_jobs (clinic_id, status, attempts, next_attempt_at)
  VALUES (v_clinic_id, 'pending', 0, NOW());

  RETURN jsonb_build_object(
    'clinic_id', v_clinic_id,
    'slug', v_slug,
    'onboarding_status', 'created',
    'existing', false
  );
END;
$$;

-- Only the backend (service role) may create clinics.
REVOKE ALL ON FUNCTION create_clinic_onboarding(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION create_clinic_onboarding(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION create_clinic_onboarding(jsonb) TO service_role;
