-- ── CLINICS ───────────────────────────────────────────────────
-- One row per clinic client
CREATE TABLE clinics (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  phone_number TEXT NOT NULL UNIQUE, -- their Twilio number
  email TEXT,
  software TEXT, -- Vagaro, Mindbody, Zenoti, Boulevard
  city TEXT,
  country TEXT,
  timezone TEXT DEFAULT 'UTC',
  services TEXT, -- comma-separated: "Botox, Filler, Laser"
  avg_service_price DECIMAL DEFAULT 0,
  booking_link TEXT, -- their Cal.com or booking URL
  greeting TEXT DEFAULT 'Hi! Thanks for reaching out.',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── CONTACTS ──────────────────────────────────────────────────
-- Every person who contacts any clinic
CREATE TABLE contacts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  clinic_id UUID REFERENCES clinics(id),
  phone_number TEXT NOT NULL,
  name TEXT,
  email TEXT,
  last_visit_date DATE,
  total_visits INTEGER DEFAULT 0,
  is_vip_member BOOLEAN DEFAULT false,
  vip_tier TEXT, -- bronze, silver, gold
  status TEXT DEFAULT 'lead', -- lead, client, dormant, vip
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(clinic_id, phone_number)
);

-- ── CONVERSATIONS ─────────────────────────────────────────────
-- Every SMS conversation thread
CREATE TABLE conversations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  clinic_id UUID REFERENCES clinics(id),
  contact_id UUID REFERENCES contacts(id),
  status TEXT DEFAULT 'active', -- active, closed, booked
  outcome TEXT, -- booked, no_response, opted_out, rebooked
  trigger_type TEXT, -- missed_call, inbound_sms, noshow, reactivation
  appointment_booked BOOLEAN DEFAULT false,
  appointment_date TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── MESSAGES ──────────────────────────────────────────────────
-- Every individual SMS message
CREATE TABLE messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id UUID REFERENCES conversations(id),
  clinic_id UUID REFERENCES clinics(id),
  contact_id UUID REFERENCES contacts(id),
  direction TEXT NOT NULL, -- inbound, outbound
  body TEXT NOT NULL,
  twilio_sid TEXT, -- Twilio message SID for reference
  ai_generated BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── MISSED CALLS ──────────────────────────────────────────────
-- Log every missed call for reporting
CREATE TABLE missed_calls (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  clinic_id UUID REFERENCES clinics(id),
  contact_id UUID REFERENCES contacts(id),
  caller_number TEXT NOT NULL,
  call_duration INTEGER DEFAULT 0,
  text_sent BOOLEAN DEFAULT false,
  text_sent_at TIMESTAMPTZ,
  converted_to_booking BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── APPOINTMENTS ──────────────────────────────────────────────
-- Track appointments booked by the AI
CREATE TABLE appointments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  clinic_id UUID REFERENCES clinics(id),
  contact_id UUID REFERENCES contacts(id),
  conversation_id UUID REFERENCES conversations(id),
  appointment_date TIMESTAMPTZ,
  service TEXT,
  status TEXT DEFAULT 'scheduled', -- scheduled, confirmed, noshow, completed, cancelled
  reminder_sent_24h BOOLEAN DEFAULT false,
  reminder_sent_2h BOOLEAN DEFAULT false,
  noshow_recovery_sent BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── REVENUE METRICS ───────────────────────────────────────────
-- Weekly/monthly metrics per clinic for the dashboard
CREATE TABLE revenue_metrics (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  clinic_id UUID REFERENCES clinics(id),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  missed_calls_total INTEGER DEFAULT 0,
  missed_calls_recovered INTEGER DEFAULT 0,
  bookings_by_ai INTEGER DEFAULT 0,
  noshows_total INTEGER DEFAULT 0,
  noshows_recovered INTEGER DEFAULT 0,
  dormant_reactivated INTEGER DEFAULT 0,
  new_vip_members INTEGER DEFAULT 0,
  mrr_added DECIMAL DEFAULT 0,
  estimated_revenue_recovered DECIMAL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── INDEXES ───────────────────────────────────────────────────
CREATE INDEX idx_contacts_clinic ON contacts(clinic_id);
CREATE INDEX idx_contacts_phone ON contacts(phone_number);
CREATE INDEX idx_conversations_clinic ON conversations(clinic_id);
CREATE INDEX idx_messages_conversation ON messages(conversation_id);
CREATE INDEX idx_messages_created ON messages(created_at);
CREATE INDEX idx_missed_calls_clinic ON missed_calls(clinic_id);
CREATE INDEX idx_appointments_clinic ON appointments(clinic_id);
CREATE INDEX idx_appointments_date ON appointments(appointment_date);

-- ── ENABLE REALTIME ───────────────────────────────────────────
-- For the live dashboard
ALTER PUBLICATION supabase_realtime ADD TABLE messages;
ALTER PUBLICATION supabase_realtime ADD TABLE missed_calls;
ALTER PUBLICATION supabase_realtime ADD TABLE appointments;

-- ── TEST CLINIC ───────────────────────────────────────────────
-- Replace the phone_number with your real Twilio number before running.
INSERT INTO clinics (
  name,
  phone_number,
  email,
  software,
  city,
  country,
  services,
  avg_service_price,
  booking_link,
  timezone
) VALUES (
  'Lumina Aesthetics — TEST',
  '+1REPLACE_WITH_YOUR_TWILIO_NUMBER',
  'test@luminaaesthetics.com',
  'Vagaro',
  'Dubai',
  'UAE',
  'Botox, Dermal Filler, Laser Resurfacing, HydraFacial',
  320,
  'https://calendly.com/cliniqboost/30min',
  'Asia/Dubai'
);
