-- ═══════════════════════════════════════════════════════════════
-- Dashboard read access (Supabase RLS)
--
-- ⚠️  READ THIS FIRST. These policies let the PUBLIC anon key SELECT all
--     rows in these tables. The anon key is embedded in dashboard/index.html,
--     which means ANYONE who opens the dashboard (or views its source) can
--     read every message, missed call, and appointment — i.e. patient PII.
--
--     Use this ONLY for a private/internal demo. For production, do NOT run
--     this — instead put the dashboard behind Supabase Auth with policies
--     scoped to the clinic's authenticated users, or serve stats from a
--     backend endpoint that uses the service key + a login (see notes below).
--
--     Run in the Supabase SQL Editor. Idempotent-ish (drops first).
-- ═══════════════════════════════════════════════════════════════

do $$
declare t text;
begin
  foreach t in array array['missed_calls','messages','conversations','appointments']
  loop
    execute format('alter table %I enable row level security;', t);
    execute format('drop policy if exists "dashboard anon read" on %I;', t);
    execute format('create policy "dashboard anon read" on %I for select to anon using (true);', t);
  end loop;
end $$;
