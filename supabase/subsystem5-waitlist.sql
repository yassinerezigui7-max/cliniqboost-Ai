-- ═══════════════════════════════════════════════════════════════
-- Sub-system 5 — waitlist table (Phase -1 migration)
--
-- ⚠️  Run this in the Supabase SQL Editor. Idempotent, safe to re-run.
--     NOTE: run supabase/pillar2-schema.sql FIRST if you haven't — the
--     Pillar-2 objects (touch_schedule + contacts columns) are still not
--     deployed, and Sub-systems 2–4 don't function until they are.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS waitlist (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  clinic_id UUID REFERENCES clinics(id),
  contact_id UUID REFERENCES contacts(id),
  service TEXT,
  preferred_date_start DATE,
  preferred_date_end DATE,
  status TEXT DEFAULT 'waiting',   -- 'waiting' | 'offered' | 'booked' | 'expired'
  offered_appointment_id UUID REFERENCES appointments(id),
  offered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_waitlist_clinic_status ON waitlist(clinic_id, status);

ALTER PUBLICATION supabase_realtime ADD TABLE waitlist;
