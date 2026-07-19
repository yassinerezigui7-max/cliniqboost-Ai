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

---

# Sub-system 5 — Appointment reminders, no-show recovery, waitlist fill

**Step 0:** run `supabase/subsystem5-waitlist.sql` (creates `waitlist`) in the Supabase
SQL Editor first — it is **not** yet deployed. (`supabase/pillar2-schema.sql` too, if you
haven't.) `appointments` and its reminder/no-show columns already exist.

All three builds are driven by one job: `npm run job:appointments` (also on cron `*/15`).

## Build 5A — Appointment reminders

Seed an appointment ~24h out (use a real `clinic_id` + `contact_id`):
```sql
insert into appointments (clinic_id, contact_id, appointment_date, service, status)
values ('CLINIC_ID', 'CONTACT_ID', now() + interval '24 hours', 'Botox', 'scheduled');
```
```bash
npm run job:appointments
```
**Expected** (`stats.reminded_24h` = 1) — a `[MOCK SMS]` 24h reminder, a `messages` row
(`twilio_sid='MOCK'`), and `appointments.reminder_sent_24h = true`.
- If the clinic's local time is outside 09:00–19:00, the 24h reminder is **deferred**
  (`stats.deferred_quiet_hours` increments, `reminder_sent_24h` stays false) and retried next run.
- A row at `now() + interval '2 hours'` yields a 2h reminder (`reminded_2h`), **ignoring quiet hours**.

**Confirmation reply** (reuses the central inbound hook — reply `YES`):
```bash
curl -X POST http://localhost:3000/webhook/twilio/inbound-sms \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "To=CLINIC_TWILIO_NUMBER" --data-urlencode "From=CONTACT_PHONE" \
  --data-urlencode "Body=YES"
```
→ `appointments.status` becomes `confirmed`.

## Build 5B — No-show recovery

Seed an appointment in the past that was never completed:
```sql
insert into appointments (clinic_id, contact_id, appointment_date, service, status)
values ('CLINIC_ID', 'CONTACT_ID', now() - interval '45 minutes', 'Botox', 'scheduled');
```
```bash
npm run job:appointments
```
**Expected** (`stats.noshow_recovered` = 1): `appointments.status = 'noshow'`,
`noshow_recovery_sent = true`, and a `[MOCK SMS]` recovery message logged to `messages`.
(No-shows do **not** auto-fill the waitlist — that's cancellation-only by design.)

## Build 5C — Cancellation → waitlist fill

Seed a waitlist entry, then cancel a matching appointment:
```sql
insert into waitlist (clinic_id, contact_id, service, status)
values ('CLINIC_ID', 'CONTACT_ID', 'Botox', 'waiting');
```
```bash
curl -X POST http://localhost:3000/webhooks/appointment-cancelled \
  -H "Content-Type: application/json" -H "x-cliniqboost-secret: $NEW_LEAD_WEBHOOK_SECRET" \
  -d '{"appointment_id":"APPOINTMENT_ID"}'
```
**Expected 200** `{ cancelled:true, offer:{ offered:true, waitlist_id, contact_id } }`:
`appointments.status='cancelled'`; the best-matching (FCFS, service/date-aware, non-opted-out)
`waitlist` row → `status='offered'`, `offered_appointment_id`, `offered_at` set; a `[MOCK SMS]`
offer logged.

**Claim** (reply `YES`): same inbound curl as 5A → `waitlist.status='booked'`.

**Offer timeout cascade:** if no reply within `WAITLIST_OFFER_WINDOW_MINUTES` (default 60), the
next `npm run job:appointments` marks that offer `status='expired'` and, if the appointment is
still `cancelled`, offers the slot to the next eligible waitlist contact (`stats.offers_cascaded`).
To test immediately, set the env var low (e.g. `WAITLIST_OFFER_WINDOW_MINUTES=0`) or back-date
`offered_at` in SQL, then re-run the job.

**Deposit enforcement is intentionally OUT OF SCOPE** (needs a Stripe/payment integration that
doesn't exist here) — scope separately later.

---

# n8n workflows

Both new workflows import with `active: false` (safe — they won't run until you enable them).
They reference two n8n environment variables (Settings → Variables, or the host env):

- `SERVER_URL` — the Railway backend base URL, e.g. `https://cliniqboost-ai-production.up.railway.app`
- `CLINIQBOOST_WEBHOOK_SECRET` — must equal the backend's `NEW_LEAD_WEBHOOK_SECRET`

**Test vs production webhook URLs:** while a workflow is inactive, open it, click **Listen for
test event**, and use the `…/webhook-test/<path>` URL. Once activated, use `…/webhook/<path>`.

## Workflow 5 — `5-new-lead-capture.json` (Meta Lead Ads + Google Ads Lead Form)

Two entry points feed one POST to `/webhooks/new-lead`:
- **Meta Lead Ads Trigger** → `Normalize Meta Lead` → HTTP
- **Google Ads Lead Form Webhook** (`google-lead-form`) → `Normalize Google Lead` → HTTP

**Before testing:** open both Code nodes and replace `REPLACE_WITH_CLINIC_UUID` with the real
clinic UUID (done per-client at onboarding).

**Test the Google branch** (curl a fake Google Lead Form payload at the webhook):
```bash
curl -X POST "$N8N_URL/webhook-test/google-lead-form" \
  -H "Content-Type: application/json" \
  -d '{
    "lead_id": "test-123",
    "user_column_data": [
      {"column_id":"FULL_NAME","string_value":"Jane Doe"},
      {"column_id":"PHONE_NUMBER","string_value":"0791234567"},
      {"column_id":"EMAIL","string_value":"jane@example.com"}
    ]
  }'
```
**Expected:** the n8n execution shows `Normalize Google Lead` outputting
`{clinic_id, source:"ad_form", name:"Jane Doe", phone:"0791234567", email, treatment_interest:null}`,
then the HTTP node POSTs it to `$SERVER_URL/webhooks/new-lead` with header
`x-cliniqboost-secret: <secret>`. The backend returns **200** `{contact_id, conversation_id}`
(or **422** if the `clinic_id` placeholder wasn't replaced, or **401** if the secret is wrong).

**Verify the auth header reaches Railway:** temporarily set `SERVER_URL` to a request inspector
(e.g. `https://webhook.site/<id>`) and confirm the `x-cliniqboost-secret` header + JSON body arrive;
or check the Railway logs for the `[new-lead]` request.

**Meta branch:** the Facebook Lead Ads Trigger can't be curled (Meta registers it and pushes leads).
Test it with Meta's **Lead Ads Testing Tool** (developers.facebook.com/tools/lead-ads-testing) against
the connected page/form, then watch the n8n execution. The `Normalize Meta Lead` node handles both the
`field_data: [{name, values}]` array and flattened first_name/last_name payload shapes.

## Workflow 6 — `6-vagaro-cancellation.json` (Vagaro cancellation → waitlist fill)

`Vagaro Cancellation Webhook` (`vagaro-appointment-cancelled`) → `Normalize Vagaro Cancellation`
→ POST `/webhooks/appointment-cancelled`. The Code node forwards **only cancellations**
(`payload.bookingStatus === "Cancel"`, or `action` deleted/cancelled) and drops everything else.

**Test a cancellation** (fake Vagaro envelope):
```bash
curl -X POST "$N8N_URL/webhook-test/vagaro-appointment-cancelled" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "evt-1",
    "type": "appointment",
    "action": "updated",
    "payload": { "appointmentId": "2dwfErtmMAFxe6hoCnQStw==", "bookingStatus": "Cancel" }
  }'
```
**Expected:** `Normalize Vagaro Cancellation` emits `{ appointment_id: "2dwfErtmMAFxe6hoCnQStw==" }`
and the HTTP node POSTs it to `$SERVER_URL/webhooks/appointment-cancelled` with the
`x-cliniqboost-secret` header.

⚠️ **Known limitation (documented in the Code node):** Vagaro's `appointmentId` is a base64
internal ID, **not** our `appointments.id` UUID — so the backend will respond **404
"appointment not found"** for a real Vagaro payload. That's expected until a Vagaro-id →
`appointments.id` lookup is added. To test the **happy path** now, replace `appointmentId` with a
real `appointments.id` UUID from Supabase → backend returns **200** `{cancelled:true, offer:{…}}`.

**Non-cancellation is ignored:** send the same payload with `"action":"created"` and
`"bookingStatus":"Confirmed"` — the workflow produces no items and nothing is POSTed.

---

# Dashboard (login-gated)

The dashboard reads patient data through a **login-gated backend endpoint** that uses the
service key server-side — the browser never receives a Supabase key (no RLS/anon-key exposure).

**Setup:** set `DASHBOARD_PASSWORD` on the server (Railway env), then start the server.

**API:**
- `POST /dashboard-api/login` `{ "password": "…" }` → `{ token }` (12h HMAC token) or 401.
- `GET /dashboard-api/stats` with `Authorization: Bearer <token>` → `{ missed_calls_today,
  messages_today, active_conversations, appointments_today, recent_messages: [...] }`; 401 without/expired token.

**Quick API test:**
```bash
TOKEN=$(curl -s -X POST http://localhost:3000/dashboard-api/login \
  -H "Content-Type: application/json" -d '{"password":"YOUR_DASHBOARD_PASSWORD"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
curl -s http://localhost:3000/dashboard-api/stats -H "Authorization: Bearer $TOKEN"
```

**Browser test:** open `http://localhost:3000/dashboard/` (or the Railway `/dashboard/` URL) →
enter the password → the stat tiles + live message feed populate and refresh every 15s. Wrong
password shows an inline error; the token is stored in `localStorage` and cleared on **Sign out**
or when it expires (a 401 bounces you back to the login screen).

> `supabase/dashboard-rls-policies.sql` is the **superseded** Option A (public anon-read policies).
> It is NOT needed with this login-gated design and should not be run in production.

---

# Automatic Onboarding — Phase 0 + 1: `POST /onboarding/submit`

Mock mode as usual: `TWILIO_SEND_ENABLED=false`, `SCHEDULER_ENABLED=false`.
No Twilio or n8n call happens in these phases at all — submit only writes to
Supabase (one RPC transaction) and mirrors a copy to Formspree.

## Step 0 — Apply the schema (REQUIRED, one time)

Run [`supabase/onboarding-schema.sql`](supabase/onboarding-schema.sql) in the
Supabase SQL Editor. Idempotent, additive. It adds the `clinics` onboarding
columns, creates `clinic_config`, `onboarding_submissions`, `provisioning_jobs`,
`integration_tasks`, `lead_sources`, `import_jobs`, and the RPC
`create_clinic_onboarding`. ⚠️ Prerequisites: `pillar2-schema.sql` and
`subsystem5-waitlist.sql` must already be applied; duplicate clinic emails must
be resolved first (the script creates a unique index on `lower(email)`):

```sql
SELECT lower(email), count(*) FROM clinics GROUP BY 1 HAVING count(*) > 1;
```

Verify after running:
```sql
select to_regclass('public.clinic_config'), to_regclass('public.provisioning_jobs');
select proname from pg_proc where proname = 'create_clinic_onboarding';
```

## Tests

**Validation failure (expect 422 with a field-keyed error map, nothing written):**
```bash
curl -i -X POST http://localhost:3000/onboarding/submit \
  -H "Content-Type: application/json" \
  -d '{"legal_name":"Test","contact_email":"bad","contact_mobile":"abc","addr_country":"US","timezone":"Mars/Olympus","booking_software":"FooSoft","services_list":""}'
```

**Unknown-field rejection (expect 422 `_unknown_fields`):** add `"evil":"1"` to any payload.

**Honeypot (expect 200 `{"ok":true}` and NOTHING written — silent drop):**
```bash
curl -i -X POST http://localhost:3000/onboarding/submit \
  -H "Content-Type: application/json" \
  -d '{"website_url":"http://spam.example"}'
```

**Happy path (expect 200 `{clinic_id, slug, onboarding_status:"created", existing:false, next_steps:[...]}`):**
```bash
curl -i -X POST http://localhost:3000/onboarding/submit \
  -H "Content-Type: application/json" \
  -d '{
    "legal_name":"Glow MedSpa LLC","dba_name":"Glow MedSpa",
    "contact_email":"owner@glowmedspa.com","contact_mobile":"(415) 555-2671",
    "addr_country":"USA","addr_city":"San Francisco",
    "timezone":"America/Los_Angeles (Pacific)","booking_software":"Vagaro",
    "services_list":"Botox, Filler, HydraFacial",
    "hours_mon_open":"09:00","hours_mon_close":"18:00","hours_sun_closed":"true",
    "quiet_start":"20:00","quiet_end":"09:00"
  }'
```

**Idempotency (run the happy-path curl again → expect 200 `{"existing":true}` with the SAME `clinic_id`, no second row).**

**Expected Supabase rows after the happy path:**

| Table | Key fields to expect |
|---|---|
| `clinics` | `is_active=false`, `onboarding_status='created'`, `slug='glow-medspa'`, `phone_number=NULL`, `booking_software_status='waiting_for_credentials'` (Vagaro) |
| `clinic_config` | `business_hours.mon={"open":"09:00",...}`, `quiet_hours={"start":"20:00","end":"09:00"}` |
| `onboarding_submissions` | `raw_payload` = the canonical payload (incl. `raw` original body), `idempotency_key` = email |
| `integration_tasks` | one `twilio_number/pending` + one `vagaro_connect/waiting_for_credentials` |
| `provisioning_jobs` | one `pending` row, `attempts=0` |

**Guardrails to confirm:**
- CORS: preflight from a non-allowlisted origin gets NO `Access-Control-Allow-Origin` header; `https://cliniqboost.com` gets one. Other routes keep the permissive global CORS.
- Body cap: any body > 64kb → 413.
- Rate limit: 11th submit from one IP inside 15 min → 429.
- Turnstile: with `TURNSTILE_SECRET_KEY` unset the check is skipped (logged); set it to enforce.
- The new clinic must NOT receive traffic: `is_active=false` means `getClinicByPhone`/`getActiveClinics` ignore it until the explicit Go-Live (Phase 2).

---

# Automatic Onboarding — Phase 2: async provisioning, status, go-live

No new SQL — Phase 0's schema covers Phase 2. Mock conventions: `N8N_URL`
unset = the n8n notify is skipped-success (logged); `TWILIO_PROVISION_ENABLED`
unset/false = the number step leaves the `twilio_number` task pending.

**What happens on submit now:** the RPC commits, the response returns
immediately, then provisioning runs post-commit via `setImmediate`
(`services/provisioning.js`): Twilio step → n8n notify → job `done` →
`onboarding_status` recomputed (`awaiting_number` until a number is attached).
Any failure re-queues the job with exponential backoff (10m → 12h, max
`PROVISIONING_MAX_ATTEMPTS`), retried by the `*/15` cron
(`jobs/provisioningRetry.js`), which also rescues jobs stuck `running` > 30 min
after a crash.

**Status polling (public, opaque UUID):**
```bash
curl -s http://localhost:3000/onboarding/status/CLINIC_ID
# → { onboarding_status, is_live, phone_number_attached, tasks:[...], provisioning:{status,attempts}, next_steps }
```

**Provision callback (n8n → Railway, secret + optional HMAC):**
```bash
curl -i -X POST http://localhost:3000/internal/provision-callback \
  -H "Content-Type: application/json" -H "x-cliniqboost-secret: testsecret123" \
  -d '{"clinic_id":"CLINIC_ID","status":"done"}'
```
Expect 200 `{job_id, status:"done", onboarding_status:...}`; wrong/missing secret → 401.
With `INTERNAL_HMAC_REQUIRED=true`, requests must also carry
`x-cliniqboost-timestamp` + `x-cliniqboost-signature` = hex
HMAC-SHA256(secret, `"<timestamp>.<raw body>"`); stale (>5 min) timestamps and
bad signatures → 401.

**Go-Live (guarded — the only way a clinic starts routing/texting):**
```bash
curl -i -X POST http://localhost:3000/onboarding/CLINIC_ID/go-live \
  -H "x-cliniqboost-secret: testsecret123"
```
- status ≠ `ready` → **409** (nothing changes)
- status `ready` → **200** `{live:true}`, `is_active=true`, `onboarding_status='live'`
- repeat call → 200 `{already_live:true}`

**Manual number attach (while Twilio billing is blocked):**
```sql
UPDATE clinics SET phone_number = '+1XXXXXXXXXX' WHERE id = 'CLINIC_ID';
UPDATE integration_tasks SET status = 'done'
  WHERE clinic_id = 'CLINIC_ID' AND type = 'twilio_number';
```
then re-run the callback curl above (status `done`) → clinic flips to `ready`
(or `awaiting_booking_integration` if a Vagaro task is still open — mark it
`done` when credentials are connected).

**Provisioning health:**
```bash
curl -s http://localhost:3000/health/provisioning
# → { status: "ok"|"degraded", jobs: {pending,running,done,failed}, stuck_pending }
```

---

# Automatic Onboarding — Phase 3: Twilio auto-provision + webhook signatures

## Number auto-provision (flag-gated)

With `TWILIO_PROVISION_ENABLED=true` **and** `TWILIO_SEND_ENABLED=false`
(mock), submitting a clinic attaches a fake `+1500555xxxx` number, closes the
`twilio_number` task, and (for non-Vagaro clinics) advances straight to
`onboarding_status='ready'` — the whole flow without spending a cent:

```bash
TWILIO_PROVISION_ENABLED=true TWILIO_SEND_ENABLED=false npm start
# then run the Phase-1 happy-path curl and poll /onboarding/status/:id
# expect: phone_number_attached=true, tasks all done, onboarding_status=ready
```

With real sends enabled, `provisionNumber` buys a local number in the
clinic's country (via `phone.js#resolveRegion`, fallback US) and sets
`voiceUrl=/webhook/twilio/missed-call`, `smsUrl=/webhook/twilio/inbound-sms`
under `SERVER_URL`. Keep `TWILIO_PROVISION_ENABLED=false` in prod until the
Twilio account is funded.

## Webhook signature enforcement (flag-gated)

`validateWebhook` now validates against `SERVER_URL + req.originalUrl` (the
URL Twilio actually calls — previously it used `N8N_URL`, so validation could
never pass). Enforcement is off by default; with `TWILIO_VALIDATE_WEBHOOK=true`:

```bash
# unsigned request → 403 <Response></Response>
curl -i -X POST http://localhost:3000/webhook/twilio/inbound-sms \
  -d "To=%2B15551234567&From=%2B15559876543&Body=hi"
```

A correctly signed request (Twilio lib: `getExpectedTwilioSignature(authToken,
SERVER_URL + path, params)`) returns 200. `/webhook/twilio/noshow` and
`/reactivate` are n8n-called and unaffected. Enable in Railway only after
verifying `SERVER_URL` is the exact public https URL configured in Twilio.

---

# CSV patient-database import — `scripts/import-contacts.js`

CLI-only tool (no app-runtime changes). All tests run against a throwaway
clinic; nothing touches Twilio/Claude/n8n.

**Setup:** create a temp clinic (any country — it sets the default phone
region), note its UUID. Sample CSVs with realistic messy data (mixed phone
formats, an in-file duplicate, one bad phone, one missing email, one
impossible date) live in `scripts/lib/sample-csvs/`.

**1. Default run aborts on bad phones, writing NOTHING (expect exit 1):**
```bash
node scripts/import-contacts.js --clinic=CLINIC_ID \
  --file=scripts/lib/sample-csvs/vagaro-sample.csv --source=vagaro
```

**2. Dry-run with --skip-invalid (expect: 7 read / 5 unique / 5 would-insert /
1 skipped, 0 rows in Supabase after):**
```bash
node scripts/import-contacts.js --clinic=CLINIC_ID \
  --file=scripts/lib/sample-csvs/vagaro-sample.csv --source=auto --dry-run --skip-invalid
```
`--source=auto` must print `Source auto-detected: vagaro`.

**3. Real run (drop --dry-run): expect `Inserted: 5`, then verify in Supabase:**
- all phones E.164 (`+1415555xxxx`), `status='patient'`
- the in-file duplicate (two rows sharing a phone) merged into ONE contact
  carrying the later `last_visit_date` and higher `total_visits`
- the impossible date (`02/30/2026`) landed as `last_visit_date=NULL`, no abort

**4. Dedup / enrichment safety:**
- Re-run the same command → `Inserted: 0, Updated: 0, Unchanged: 5`.
- Manually set one contact's `name` to something custom and its
  `total_visits`/`last_visit_date` to stale values, re-run → `Updated: 1`,
  stats refreshed, **custom name untouched**.

**5. Errors report:** any skipped row appears in `<input>.errors.csv` with the
original columns plus a `reason` column.

**Cleanup:** delete the temp clinic's contacts, then the clinic row.
