-- ═══════════════════════════════════════════════════════════════
-- Pillar 2 — Lead Engine schema
--
-- ⚠️  These objects were expected to already exist in production but do NOT.
--     Run this ONCE in the Supabase SQL Editor before using the lead engine.
--     Written idempotently (IF NOT EXISTS) so it's safe to re-run.
-- ═══════════════════════════════════════════════════════════════

-- ── contacts: new columns (VIP retention) ─────────────────────
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS renewal_date DATE;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS allowance_used_this_cycle JSONB;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS allowance_total_this_cycle JSONB;

-- ── touch_schedule ────────────────────────────────────────────
-- One row per scheduled outreach "touch" (nurture, reactivation, or VIP).
CREATE TABLE IF NOT EXISTS touch_schedule (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  clinic_id UUID REFERENCES clinics(id),
  contact_id UUID REFERENCES contacts(id),
  sequence_type TEXT NOT NULL
    CHECK (sequence_type IN ('new_lead_nurture', 'reactivation', 'vip_retention')),
  -- reminder_type only applies to vip_retention rows; NULL otherwise.
  reminder_type TEXT
    CHECK (reminder_type IN ('unused_benefit', 'renewal', 'rebooking', 'tier_upgrade')),
  touch_number INTEGER DEFAULT 1,
  scheduled_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  outcome TEXT DEFAULT 'pending'
    CHECK (outcome IN ('pending', 'booked', 'renewed', 'opted_out', 'no_response')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── indexes ───────────────────────────────────────────────────
-- Scheduler hot path: due, pending, not-yet-sent rows ordered by scheduled_at.
CREATE INDEX IF NOT EXISTS idx_touch_schedule_due
  ON touch_schedule (scheduled_at)
  WHERE outcome = 'pending' AND sent_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_touch_schedule_contact ON touch_schedule (contact_id);
CREATE INDEX IF NOT EXISTS idx_touch_schedule_clinic ON touch_schedule (clinic_id);
-- VIP dedupe lookups (contact + reminder_type + created_at).
CREATE INDEX IF NOT EXISTS idx_touch_schedule_vip_dedupe
  ON touch_schedule (contact_id, reminder_type, created_at)
  WHERE sequence_type = 'vip_retention';

-- Optional: realtime for a future dashboard view of the sequence engine.
-- ALTER PUBLICATION supabase_realtime ADD TABLE touch_schedule;
