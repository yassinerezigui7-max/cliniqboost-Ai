# Multi-Tenant Isolation Audit — cliniqboost

**Phase 1 (read-only audit).** No writes, no DDL, no destructive SQL were run.
Date: 2026-07-21. Live Supabase project probed read-only: `qakqwcyoeqkfqvgjibkv`.

---

## 0. How this audit was produced

| Source | Used for |
|---|---|
| `supabase/schema.sql`, `pillar2-schema.sql`, `subsystem5-waitlist.sql`, `onboarding-schema.sql`, `dashboard-rls-policies.sql` | Authoritative DDL for column/type/constraint structure |
| Live DB probe (service key, read-only): table existence, row counts, `clinic_id IS NULL` counts, `clinics` sample | Confirming schema files match the live DB + finding drift |
| Live DB probe (anon key, read-only): `SELECT ... LIMIT 1` on patient tables | Testing whether the public anon key can read cross-tenant data **right now** |
| `server/services/supabase.js`, all `server/routes/*.js`, `server/index.js` | How `clinic_id` actually flows (feeds Phase 5, informs classification) |

**Limitation:** PostgREST does not expose `information_schema` / `pg_policies`, so exact
column types, per-column nullability, and the precise RLS policy text on the **live** DB
could not be introspected over the REST API. Structure below is taken from the repo DDL
(confirmed to match live by existence + behavior tests). Items that require the Supabase SQL
editor or a direct Postgres connection to confirm are marked **⚠ VERIFY IN SQL EDITOR**.

---

## 1. Executive summary / verdict

**Not safe to onboard a 5th paying clinic on the isolation guarantees as written in the repo.**
The live DB is in a *better* state than `schema.sql` suggests (RLS appears enabled and
deny-by-default for the anon key on the core patient tables — see §3), but the guarantees are
**not enforced at the schema level and not encoded in the repo**, so they are one migration,
one code path, or one `dashboard-rls-policies.sql` run away from breaking silently.

Top issues, in priority order:

1. **`clinic_id` is nullable and has an unenforced FK on every tenant table.** Nothing in the
   database stops an orphan (NULL `clinic_id`) row from being written. Today 0 such rows exist,
   but the guarantee is behavioral (application code), not structural.
2. **`dashboard-rls-policies.sql` is a loaded footgun in the repo.** It creates
   `USING (true)` anon SELECT policies on `messages`, `missed_calls`, `conversations`,
   `appointments`. The anon key is public. If anyone runs that file, every clinic's patient PII
   becomes world-readable in one step. It is currently **not** active on live (verified), but it
   sits in the repo labeled only with a comment.
3. **RLS state is inconsistent between the repo and the live DB.** `onboarding-schema.sql`
   enables RLS on 6 onboarding tables; **no repo file enables RLS on the core patient tables**
   (`clinics/contacts/conversations/messages/missed_calls/appointments/revenue_metrics/
   touch_schedule/waitlist`). Yet the live probe shows anon is denied on those too — meaning the
   live RLS was configured out-of-band and is **not reproducible from the repo**.
4. **The dashboard read path is not a tenant boundary by design.** `/dashboard-api/stats` with
   `clinic_id` omitted or `=all` aggregates across every clinic (confirmed in
   `routes/dashboard.js` and `services/supabase.js`), gated only by a single shared
   `DASHBOARD_PASSWORD`. Fine for a solo operator; a hard blocker for per-clinic dashboard logins.
5. **Schema drift / gaps:** `revenue_metrics` has no `clinic_id` index; there is no
   `external_appointment_id` column anywhere (the Vagaro base64/UUID item references a column that
   does not yet exist); and there is **no `users`/`team_members` (staff) table at all** — so no
   per-staff tenancy model exists, which Option A (future dashboard logins) will require.

---

## 2. Table inventory + classification

Legend — **RLS (repo)**: what the committed SQL does. **RLS (live)**: inferred from the anon
read test (▲ = anon denied on live; ✗ = not set by any repo file). `clinic_id` FK = column
references `clinics(id)` but is **nullable** and **not** `NOT NULL` unless stated.

| Table | Classification | Rows (live) | NULL clinic_id | `clinic_id`? | FK→clinics | RLS (repo) | RLS (live, anon test) |
|---|---|---|---|---|---|---|---|
| `clinics` | **Tenant root** | 4 | n/a | (is the root; `id` PK) | — | none in repo | anon denied ▲ |
| `contacts` | Clinic-owned | 9 | 0 | yes, nullable | yes, unenforced | none in repo ✗ | anon denied ▲ |
| `conversations` | Clinic-owned | 10 | 0 | yes, nullable | yes, unenforced | none in repo ✗ | anon denied ▲ |
| `messages` | Clinic-owned (PII) | 45 | 0 | yes, nullable | yes, unenforced | **`USING(true)` anon** if `dashboard-rls-policies.sql` run | anon denied ▲ (policy not active) |
| `missed_calls` | Clinic-owned (PII) | 2 | 0 | yes, nullable | yes, unenforced | **`USING(true)` anon** if that file run | anon denied ▲ |
| `appointments` | Clinic-owned | 0 | 0 | yes, nullable | yes, unenforced | **`USING(true)` anon** if that file run | anon denied ▲ |
| `revenue_metrics` | Clinic-owned | 0 | 0 | yes, nullable | yes, unenforced | none in repo ✗ | anon denied ▲ |
| `touch_schedule` | Clinic-owned | 6 | 0 | yes, nullable | yes, unenforced | none in repo ✗ | anon denied ▲ |
| `waitlist` | Clinic-owned | 0 | 0 | yes, nullable | yes, unenforced | none in repo ✗ | anon denied ▲ |
| `clinic_config` | Clinic-owned (1:1) | 3 | 0 | yes (PK=clinic_id) | yes | **enabled**, deny-default | anon denied ▲ |
| `onboarding_submissions` | Clinic-owned (audit) | 3 | 0 | yes, nullable | yes | **enabled**, deny-default | anon denied ▲ |
| `provisioning_jobs` | Clinic-owned (ops) | 3 | 0 | yes, nullable | yes | **enabled**, deny-default | (not tested) |
| `integration_tasks` | Clinic-owned (ops) | 3 | 0 | yes, nullable | yes | **enabled**, deny-default | (not tested) |
| `lead_sources` | Clinic-owned (routing) | 0 | 0 | yes, nullable | yes | **enabled**, deny-default | (not tested) |
| `import_jobs` | Clinic-owned (ops) | 0 | 0 | yes, nullable | yes | **enabled**, deny-default | (not tested) |
| `users` | **does not exist** | — | — | — | — | — | — |
| `team_members` | **does not exist** | — | — | — | — | — | — |

Global/shared tables: **none identified.** There is no pricing/plans/system-config table; plan
data lives as free-text columns on `clinics`. Every non-root table is clinic-owned.

**`users` / `team_members` — resolved (do NOT exist).** A follow-up read-only probe (full
`SELECT`) confirmed both return PostgREST's *"Could not find the table 'public.<t>' in the schema
cache"*. My first pass reported them "exists" — that was a **false positive** from a `head`-count
request; the definitive `SELECT` shows they are absent. Consequence: **there is no team-member /
staff table anywhere (repo or live), and thus no per-staff tenancy model today.** This is not a
drift/leak — it's a *missing capability* that Phase 2 must design if clinic staff will ever log
into a dashboard (i.e. the Option A future). There are no ambiguous tables remaining.

### Keys / constraints / indexes (from repo DDL — ⚠ VERIFY IN SQL EDITOR for live)

- **PKs:** all tables use `id UUID DEFAULT gen_random_uuid()` except `clinic_config` (PK =
  `clinic_id`).
- **Unique constraints:** `clinics.phone_number` UNIQUE (note: made nullable in
  `onboarding-schema.sql`); partial unique indexes `idx_clinics_email_unique` (lower(email)),
  `idx_clinics_slug_unique`; `contacts UNIQUE(clinic_id, phone_number)` ✅ tenant-scoped;
  `onboarding_submissions.idempotency_key` UNIQUE; `lead_sources UNIQUE(channel, external_id)`.
- **FKs:** all `clinic_id` columns reference `clinics(id)`; child tables also FK to
  `contacts`/`conversations`/`appointments`. All are nullable.
- **Indexes on `clinic_id`:** present for `contacts`, `conversations`, `missed_calls`,
  `appointments`, `touch_schedule`, `waitlist(clinic_id,status)`, and the onboarding tables.
  **Missing:** `messages` (indexed only by `conversation_id`, `created_at` — but dashboard
  queries filter `messages.clinic_id`), `revenue_metrics` (no `clinic_id` index at all).
- **Realtime publication:** `messages`, `missed_calls`, `appointments`, `waitlist` are in
  `supabase_realtime`. Safe today (anon denied) but compounds risk #2 — see §4.

---

## 3. Where multi-tenant isolation is broken or missing (specific)

**B1 — `clinic_id` nullable + FK not enforced, every tenant table.**
`clinic_id UUID REFERENCES clinics(id)` with no `NOT NULL`. A future code path, n8n workflow, or
manual insert can create a row with `clinic_id = NULL` that belongs to no clinic and is invisible
to every clinic-scoped query yet still present in unscoped ones. *Structural fix: backfill (none
needed — 0 nulls today) then `SET NOT NULL` + validated FK.*

**B2 — Core patient tables have no RLS in the repo.** `schema.sql`, `pillar2-schema.sql`,
`subsystem5-waitlist.sql` never `ENABLE ROW LEVEL SECURITY`. Live has anon locked down, but that
config exists only in the live project, not in version control — a project rebuild, restore, or
new environment from the repo would come up with **RLS off on all patient tables**. (`clinic_id`,
`contacts`, `messages`, etc.)

**B3 — `dashboard-rls-policies.sql` grants `USING (true)` to `anon`.** Lines create anon SELECT
policies on `missed_calls`, `messages`, `conversations`, `appointments`. The anon key is embedded
in any client that uses it and is not a secret. Running this file = immediate, total cross-tenant
PII exposure. It is currently inert on live (anon test returned 0 rows), but its presence in the
repo with only a warning comment is itself the vulnerability.

**B4 — Dashboard aggregates cross-tenant by design.** `routes/dashboard.js` `/stats` and
`getDashboardStats`/`getRecentMessages` (in `services/supabase.js`) treat `clinic_id` as an
optional *view filter*; omitted or `'all'` returns all clinics' rows. Auth is one shared
`DASHBOARD_PASSWORD`. There is no mapping from an authenticated principal to a single clinic. This
cannot become a per-clinic customer dashboard without a real tenant-scoped auth model.

**B5 — Trust-boundary inputs take `clinic_id` from the request body.** `POST /webhook/twilio/noshow`
and `/reactivate` (`routes/twilio.js`) and `POST /webhooks/new-lead` (`routes/leads.js`) read
`clinic_id` from the caller. These are n8n-authenticated (shared secret / optional HMAC), so it's
a *trusted* caller today — but the `clinic_id` is asserted by the payload, not derived from a
signed identity. A leaked webhook secret lets a caller write into any clinic. (Full call-site list
is Phase 5.) *Note the safe counter-example:* the Twilio `/missed-call` and `/inbound-sms`
handlers correctly resolve the clinic from the **receiving** number via `getClinicByPhone(To)` —
that is the pattern to standardize on.

**B6 — Missing indexes for tenant-filtered reads.** `messages.clinic_id` and
`revenue_metrics.clinic_id` are unindexed though queried by clinic. Not an isolation *hole* but a
scaling/perf blocker at 100+ clinics and worth folding into the Phase 3 index work.

---

## 4. Concrete risk scenarios if a real clinic #5 is onboarded today

1. **Orphaned-write leak (B1 + B4).** A new n8n workflow or a refactor calls `saveMessage()` /
   `logMissedCall()` and forgets to pass `clinic_id` (nothing forces it — the column is nullable).
   The row is written with `clinic_id = NULL`. Clinic-scoped queries never see it, but the
   solo-operator dashboard's **`clinic_id='all'`** view and any unscoped report *do* — the message
   body (patient PII) surfaces attributed to "Unknown," mixed with clinic A's and clinic B's
   traffic. No error is ever raised.

2. **One-line total exposure (B3).** An operator, seeing "dashboard read access" in the filename,
   runs `dashboard-rls-policies.sql` to "make the dashboard work." Instantly, `messages`,
   `missed_calls`, `conversations`, `appointments` become readable by the **public anon key** for
   **all** clinics. Because those tables are also in `supabase_realtime`, anyone with the anon key
   (or who views a client bundle that embeds it) can *subscribe to a live stream* of every clinic's
   inbound patient texts. Clinic B's patients' messages show up in a request made in clinic A's
   context — or made by no clinic at all.

3. **Environment rebuild regression (B2).** The team spins up a staging project from the repo SQL
   (`schema.sql` + friends). RLS comes up **disabled** on all patient tables (no repo file enables
   it). If the anon key for that project is used by any front-end, every clinic's data is readable
   with no policy in the way — the live prod hardening was never captured in code, so it doesn't
   travel.

4. **Cross-tenant write via asserted `clinic_id` (B5).** Clinic B's integrator (or an attacker who
   obtained the shared `NEW_LEAD_WEBHOOK_SECRET`) posts to `/webhooks/new-lead` with clinic A's
   `clinic_id`. The lead, the AI-generated SMS, and the nurture schedule are all created under
   clinic A — clinic A's Twilio number texts a stranger, and the contact appears in clinic A's
   data. The secret is shared across all clinics, so it is not an identity.

---

## 5. Gap list — `schema.sql` (repo) vs. live database

| # | Gap | Repo says | Live is |
|---|---|---|---|
| G1 | RLS on core patient tables | not enabled anywhere in repo | anon **denied** (RLS effectively on) — config exists only on live, not in VCS |
| G2 | `dashboard-rls-policies.sql` `USING(true)` anon policies | present in repo | **not active** on live (anon returned 0 rows on `messages` despite 45 rows) |
| G3 | `users`, `team_members` tables | absent from all repo SQL | **also absent on live** (confirmed via `SELECT` — no drift; no team/staff model exists at all) |
| G4 | `clinics` seed row | `schema.sql` inserts "Lumina Aesthetics — TEST" with placeholder number | live has 4 clinics incl. that TEST row (`+12494212535`, active) + 3 onboarded |
| G5 | `clinics.phone_number` nullability | base `schema.sql` = `NOT NULL UNIQUE`; `onboarding-schema.sql` drops NOT NULL | live matches onboarding (one clinic has NULL phone) — so onboarding migration **was** applied |
| G6 | `clinic_id` NOT NULL constraints | never declared | not enforced (nullable) — consistent, but the guarantee is code-only |
| G7 | `messages.clinic_id`, `revenue_metrics.clinic_id` indexes | not created | ⚠ VERIFY — not in repo, assume absent |
| G8 | `external_appointment_id` (Vagaro) | **no such column** in any table | absent — the base64/UUID fix references a column that must first be added (see Phase 5) |

**Positive confirmations from live:** all 15 repo tables exist; **0 rows with NULL `clinic_id`**
on any tenant table (backfill will be a no-op for existing data); onboarding tables carry the
intended deny-by-default RLS; `contacts` uses the correct tenant-scoped unique key
`(clinic_id, phone_number)`.

---

## 6. Manual-review items (flagged, not guessed)

- **M1 — RESOLVED:** `users` / `team_members` do not exist (confirmed). No action needed beyond
  Phase 2 designing a staff/team model *if* per-clinic dashboard logins are wanted (Option A future).
- **M2 — Live RLS ground truth:** run `SELECT relname, relrowsecurity FROM pg_class WHERE
  relnamespace = 'public'::regnamespace;` and `SELECT * FROM pg_policies WHERE schemaname='public';`
  to capture the *actual* live policies so §3/B2/G1 can be reconciled and codified.
- **M3 — Column-level nullability/types** for all tables (PostgREST couldn't introspect them).

---

## 7. What is already correct (keep these)

- Contacts are uniquely keyed per tenant: `UNIQUE(clinic_id, phone_number)`.
- Onboarding-family tables (`clinic_config`, `onboarding_submissions`, `provisioning_jobs`,
  `integration_tasks`, `lead_sources`, `import_jobs`) already have RLS enabled deny-by-default.
- The inbound Twilio path resolves the clinic from the **receiving phone number**
  (`getClinicByPhone(To)`), never from caller-supplied data — the correct trust model.
- Clinic creation is funneled through a single `SECURITY DEFINER` RPC (`create_clinic_onboarding`)
  granted only to `service_role` — a good single point of tenant birth.
- All existing data is clean: 0 orphan rows.

---

## STOP — awaiting your approval for Phase 2

Per your instructions I have made **no writes** and will not design the target architecture
(`ARCHITECTURE_PROPOSAL.md`) or write any SQL until you explicitly approve Phase 1.

Decisions carried into Phase 2:
1. **RLS strategy — DECIDED:** Option B now (service-role backend as the only writer +
   session-variable RLS, `current_setting('app.current_clinic_id')`, as defense-in-depth), with the
   schema built so Option A (Supabase Auth + JWT `clinic_id` claim) can be layered on later.
2. **`users`/`team_members` — RESOLVED:** they don't exist; there is no staff/team model yet.
   Phase 2 will propose one only as the Option-A-ready path for future per-clinic dashboard logins.
