# cliniqboost AI System

Revenue Operating System backend for medical spas.

## What it does
- Missed call text-back in under 30 seconds
- AI SMS conversations powered by Claude
- No-show recovery sequences
- Dormant patient reactivation
- Real-time dashboard

## Stack
- Node.js + Express (server)
- Twilio (SMS + calls)
- Claude API by Anthropic (AI brain)
- Supabase (database + realtime)
- n8n (workflow automation)

## Setup

1. Clone this repo
2. Fill in the credentials in `.env` (Twilio, Anthropic, Supabase, n8n)
3. Run `npm install`
4. Run the Supabase schema: copy `supabase/schema.sql`
   and run it in the Supabase SQL Editor
5. Run `npm start`
6. Configure Twilio webhooks (see below)

## Deploy
Recommended: Railway.app or Render.com (both free tier available)

## Add a new clinic
Insert a row in the `clinics` table with the clinic's
Twilio phone number and their information.
The system automatically routes all calls/texts for that
number to their specific AI configuration.

## Importing a client's patient database

During onboarding, import the clinic's existing patient CSV (exported from
Vagaro, Mindbody, Boulevard, Zenoti, or Square Appointments) with
`scripts/import-contacts.js`. It maps each software's column names
automatically (`--source=auto` detects the format from the header), normalizes
every phone to E.164 using the clinic's country, dedupes on
`(clinic_id, phone_number)` — refreshing last-visit/visit-count on existing
contacts without ever overwriting a name or email the AI has already
enriched — and writes any skipped rows to a `<file>.errors.csv` for review.
Run with `--dry-run` first to see what would happen, and `--skip-invalid` to
import past rows with bad phone numbers instead of aborting:

```bash
node scripts/import-contacts.js \
  --clinic=a3ed4432-0210-40dc-9692-7ee306bc72b9 \
  --file=~/Downloads/patients.csv --source=auto --dry-run
```

## Configure Twilio webhooks

After the server is deployed, point Twilio at it:

1. Go to console.twilio.com
2. Phone Numbers → Manage → Active Numbers
3. Click your phone number
4. Under "Voice & Fax":
   - "A Call Comes In" → Webhook
   - URL: `https://YOUR_SERVER_URL/webhook/twilio/missed-call`
   - HTTP Method: POST
5. Under "Messaging":
   - "A Message Comes In" → Webhook
   - URL: `https://YOUR_SERVER_URL/webhook/twilio/inbound-sms`
   - HTTP Method: POST
6. Click Save

## Dashboard
Visit `/dashboard` to see live message feed and stats. Fill in
`SUPABASE_URL` and `SUPABASE_ANON_KEY` at the top of `dashboard/index.html`
before deploying it.

Built by cliniqboost · cliniqboost.com
