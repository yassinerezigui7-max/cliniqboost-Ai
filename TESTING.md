# Pillar 2 — Lead Engine: Testing Guide

All testing runs in **mock mode** — set `TWILIO_SEND_ENABLED=false` so no real Twilio
API call is ever made. Outbound messages are logged to the console as `[MOCK SMS]`
and stored in `messages` with `twilio_sid = 'MOCK'`. (Claude API calls are real.)

---

## Step 0 — Apply the schema (REQUIRED, one time)

⚠️ The Pillar-2 objects were **not** present in production when this was built.
Run [`supabase/pillar2-schema.sql`](supabase/pillar2-schema.sql) in the Supabase
SQL Editor first. It creates `touch_schedule` and adds the new `contacts` columns
(`renewal_date`, `allowance_used_this_cycle`, `allowance_total_this_cycle`). It's
idempotent (`IF NOT EXISTS`), safe to re-run.

Verify:
```sql
select to_regclass('public.touch_schedule');            -- not null
select column_name from information_schema.columns
  where table_name='contacts' and column_name like 'allowance%';
```

## Step 0b — Local env

Copy `.env.example` → `.env` and set at minimum:
```
TWILIO_SEND_ENABLED=false
SCHEDULER_ENABLED=false            # so cron doesn't fire during manual tests
NEW_LEAD_WEBHOOK_SECRET=testsecret123
```
Start the server: `npm start` (defaults to port 3000; examples below use 3000).

---

## Build 1 — New-lead webhook  `POST /webhooks/new-lead`

Replace `CLINIC_ID` with an active clinic (test clinic in prod is
`a3ed4432-0210-40dc-9692-7ee306bc72b9`, country UAE).

**Auth failure (expect 401):**
```bash
curl -i -X POST http://localhost:3000/webhooks/new-lead \
  -H "Content-Type: application/json" \
  -d '{"clinic_id":"CLINIC_ID","phone":"0509876543"}'
```

**Validation failure (expect 422):**
```bash
curl -i -X POST http://localhost:3000/webhooks/new-lead \
  -H "Content-Type: application/json" -H "x-cliniqboost-secret: testsecret123" \
  -d '{"clinic_id":"CLINIC_ID","phone":"abc"}'
```

**Happy path (expect 200 `{contact_id, conversation_id, ...}`):**
```bash
curl -i -X POST http://localhost:3000/webhooks/new-lead \
  -H "Content-Type: application/json" -H "x-cliniqboost-secret: testsecret123" \
  -d '{
    "clinic_id":"CLINIC_ID",
    "source":"ad_form",
    "name":"Jane Test",
    "phone":"0509876543",
    "treatment_interest":"Botox"
  }'
```

**Idempotency (run the happy-path curl again within 10 min → expect 200 `{"deduped":true}`).**

**Expected Supabase rows after the happy path:**

| Table | Key fields to expect |
|---|---|
| `contacts` | `phone_number='+971509876543'`, `status='lead'` (unchanged if pre-existing client/vip), `name='Jane Test'` |
| `conversations` | `trigger_type='new_lead'`, `status='active'`, matches returned `conversation_id` |
| `messages` | `direction='outbound'`, `ai_generated=true`, `twilio_sid='MOCK'`, `body`=the AI first message |
| `touch_schedule` | `sequence_type='new_lead_nurture'`, `touch_number=1`, `outcome='pending'`, `scheduled_at`≈ now + `NURTURE_TOUCH1_DELAY_HOURS` |

### Reply short-circuit (booking / opt-out detection)

The hook lives in the existing inbound-SMS handler and only acts if the contact
has **pending** `touch_schedule` rows. Simulate an inbound SMS (`To` = the clinic's
Twilio number, `From` = the lead):
```bash
# Opt-out — expect all pending touches -> outcome 'opted_out' and contact.status='opted_out'
curl -X POST http://localhost:3000/webhook/twilio/inbound-sms \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "To=+12494212535" --data-urlencode "From=+971509876543" \
  --data-urlencode "Body=STOP please remove me"

# Booking — expect all pending touches -> outcome 'booked'
#   ...Body=Yes! book me in for tomorrow please
```
Check `touch_schedule.outcome` and `contacts.status` for that contact afterward.

---

## Build 2 — Sequence scheduler (nurture + reactivation)

Run one pass manually (no need to wait for the `*/15` cron):
```bash
npm run job:sequences
```
Prints a summary like `{ due, sent, rescheduled, opted_out, skipped, failed, staleVipClosed }`.

**To see an actual mock send**, insert a due row (SQL) then run the job:
```sql
insert into touch_schedule (clinic_id, contact_id, sequence_type, touch_number, scheduled_at)
values ('CLINIC_ID', 'CONTACT_ID', 'new_lead_nurture', 1, now() - interval '1 minute');
```
```bash
npm run job:sequences
```
**Expected:**
- If the clinic's **local** time is 09:00–19:00 → a `[MOCK SMS]` log, a new `messages`
  row (`twilio_sid='MOCK'`), the touch's `sent_at` set, and a **new** `touch_schedule`
  row for `touch_number=2` (`scheduled_at` ≈ now + 2 days — progressive backoff 2/3/4/5d).
- If **outside** 09:00–19:00 local → the row's `scheduled_at` is pushed to the next
  09:00 local and nothing is sent (`rescheduled` count increments). This is the
  quiet-hours guard working.

Reactivation rows behave the same with max 3 touches, +5 days spacing.

---

## Build 3 — Prompts

No endpoint. Verified indirectly: the `body` of every mock-sent message reflects the
right template (first message references the enquiry; nurture touches escalate; VIP
messages read as membership perks). Templates live in
[`prompts/lead-engine-prompts.js`](prompts/lead-engine-prompts.js).

---

## Build 4 — VIP retention sweep

Seed a VIP contact, then run the sweep:
```sql
update contacts
   set is_vip_member = true,
       vip_tier = 'silver',
       renewal_date = (now() + interval '5 days')::date,
       last_visit_date = (now() - interval '60 days')::date,
       allowance_total_this_cycle = '{"Botox": 4}'::jsonb,
       allowance_used_this_cycle  = '{"Botox": 1}'::jsonb
 where id = 'CONTACT_ID';
```
```bash
npm run job:vip-sweep
```
Prints `{ clinics, contacts, renewal, unused_benefit, rebooking, tier_upgrade, skipped }`.

**Expected `touch_schedule` rows inserted** (`sequence_type='vip_retention'`, `outcome='pending'`, `scheduled_at`≈now):
- `renewal` — because `renewal_date` is within 7 days.
- `unused_benefit` — 1 of 4 used (<50%) and renewal within 14 days.
- `rebooking` — last visit 60 days ago (> `VIP_REBOOK_THRESHOLD_DAYS`, default 45).
- (`tier_upgrade` only if usage ≥ 100% of allowance and `vip_tier != 'gold'`.)

Re-running the sweep the same day inserts **nothing new** (per-reminder_type dedupe:
30 days for renewal/unused_benefit/rebooking, 90 days for tier_upgrade).

The daily cron fires at `0 10 * * *` server time; the per-clinic quiet-hours are
applied later, when the **sequence scheduler** actually sends the row.

---

## End-to-end (all in mock mode)

1. `POST /webhooks/new-lead` → contact + conversation + mock first message + touch 1.
2. `npm run job:sequences` (with a due row) → mock nurture send + touch 2 scheduled.
3. Inbound `STOP` → pending touches `opted_out`, contact `status='opted_out'`.
4. `npm run job:vip-sweep` → VIP reminder rows inserted; picked up by the sequence job.

No real Twilio call occurs at any step while `TWILIO_SEND_ENABLED=false`.
