# Phase 5 — Backend / n8n / Webhook Tenancy Review

**Read-only review.** No backend code, workflow, or config was modified. This lists every
tenant-safety call site with file:line and the fix needed, ranked by severity. Awaiting your
approval before any fix.

**Context that sets the bar:** After Phase 4, the DB enforces isolation for every *non-service-role*
connection. But the Railway backend and the n8n Supabase nodes use keys that **bypass or predate**
RLS, so **application-layer `clinic_id` scoping is still the primary boundary today** (Option B).
This review is about whether that layer is airtight.

---

## Severity summary

| ID | Severity | Where | Issue |
|----|----------|-------|-------|
| **H1** | **High** | `server/routes/twilio.js:157,189` | `/noshow` + `/reactivate` are **unauthenticated** and take `clinic_id` from the body |
| **H2** | **High** | `server/routes/twilio.js:157` | `/noshow` never checks the `contact` belongs to the `clinic` (independent id lookups) |
| **M1** | Medium | `n8n-workflows/3-noshow-recovery.json` | Supabase `getAll appointments` has **no `clinic_id` filter** (cross-clinic read); also duplicates a backend cron |
| **M2** | Medium | `server/routes/leads.js:15`, `server/routes/appointments.js:11` | Single shared secret is not a per-clinic identity; `clinic_id`/`appointment_id` asserted by caller |
| **M3** | Medium | `n8n-workflows/3,4` Supabase nodes | Direct-DB writes bypass the app-layer scoping (and RLS if using the service key) |
| **V** | Medium | `n8n-workflows/6` + `appointment-cancelled` | Vagaro `external_appointment_id` base64/UUID mismatch — the fix **must** be clinic-scoped |
| L1–L4 | Low | various | Defense-in-depth: PK/contact-scoped queries without a redundant `clinic_id` predicate |

---

## 1. Twilio webhook handlers

| Handler | File:line | Clinic resolution | Verdict |
|---|---|---|---|
| `/missed-call` | `twilio.js:22` | `getClinicByPhone(To)` — from the **receiving** number | ✅ Correct + Twilio-signature-guarded (`twilio.js:11`, when `TWILIO_VALIDATE_WEBHOOK=true`) |
| `/inbound-sms` | `twilio.js:84` | `getClinicByPhone(To)`; contact via `getOrCreateContact(clinic.id, From)` | ✅ Correct + signature-guarded |
| `/noshow` | `twilio.js:157` | `clinic_id` **and** `contact_id` read from **request body**; each loaded by id independently (`twilio.js:161,163`) | ❌ **H1 + H2** |
| `/reactivate` | `twilio.js:189` | `clinic_id` from **request body**; then blasts that clinic's entire dormant list | ❌ **H1** |

**H1 — `/noshow` and `/reactivate` are unauthenticated.** The guard at `twilio.js:11` only lists
`['/missed-call','/inbound-sms']`. Neither `/noshow` nor `/reactivate` checks a shared secret,
HMAC, or Twilio signature. Anyone who can reach the server can:
- POST `/webhook/twilio/noshow` with **any** `clinic_id` + **any** `contact_id` → sends an SMS from
  that clinic's number to an arbitrary contact (cross-tenant + attacker-chosen recipient), or
- POST `/webhook/twilio/reactivate` with any `clinic_id` → triggers a mass text to that clinic's
  entire dormant contact list (cost/spam/abuse; also `getDormantContacts` is correctly clinic-scoped,
  so this is a "text a whole tenant on demand" primitive).

*Fix:* wrap both routes in `verifyRequest` (the same shared-secret + optional HMAC used by
`/internal/*` and go-live), matching how n8n already signs other calls. Best: move the no-show and
reactivation logic entirely onto the existing backend crons (see M1) and delete these ad-hoc
endpoints.

**H2 — `/noshow` doesn't bind contact to clinic.** `twilio.js:161-164` loads `clinic` by
`clinic_id` and `contact` by `contact_id` in two independent queries and never asserts
`contact.clinic_id === clinic.id`. Even with auth added, a caller can pair clinic A with clinic B's
contact. *Fix:* after loading, reject if `contact.clinic_id !== clinic.id`.

---

## 2. n8n workflows

| # | Workflow | DB access | Clinic scoping | Verdict |
|---|---|---|---|---|
| 1 | missed-call-textback | HTTP → `/missed-call` | backend resolves clinic from `To` | ✅ |
| 2 | sms-conversation | HTTP → `/inbound-sms` | backend resolves clinic from `To` | ✅ |
| 3 | noshow-recovery | **direct Supabase** `getAll appointments` + HTTP → `/noshow` | **no `clinic_id` filter** on the read | ❌ **M1** |
| 4 | dormant-reactivation | direct Supabase `getAll clinics (is_active)` + HTTP → `/reactivate` | cross-clinic read is intentional (needs all clinics); forwards per-clinic `clinic_id` | ⚠️ M3 (relies on unauth H1 endpoint) |
| 5 | new-lead-capture | HTTP → `/webhooks/new-lead` | code node emits `clinic_id`; backend validates exists+active | ⚠️ M2 |
| 6 | vagaro-cancellation | HTTP → `/webhooks/appointment-cancelled` | forwards `appointment_id` only | ⚠️ **V** |

**M1 — Workflow 3 "Get Past-Due Appointments"** (`n8n-nodes-base.supabase`, `getAll`, `tableId:
appointments`) filters only `status=scheduled` + `noshow_recovery_sent=false` — **no `clinic_id`
and no date cutoff**. It pulls every clinic's matching appointments in one query, then forwards each
row's `clinic_id`/`contact_id` to `/noshow`. Two problems: (a) it's a cross-tenant read that, post-
Phase-4, either returns 0 rows (if the node uses the anon key → workflow silently dead) or bypasses
RLS (if it uses the service key); (b) it **duplicates** the backend's own `runNoShowRecovery` cron
(`server/jobs/appointmentJob.js:70`, `getNoShowCandidates`) which already does this correctly and
per-row-scoped. *Fix:* retire workflow 3 and let the backend cron own no-show recovery; or, if kept,
add a `clinic_id` filter, an `appointment_date < now` cutoff, and route the send through an
authenticated endpoint. The `Mark Recovery Sent` update node (`filter: id = {{$json.id}}`) is
correct-by-PK but should also carry `clinic_id` for defense-in-depth.

**M3 — Direct Supabase nodes in n8n bypass the app-layer boundary.** In Option B, the app layer is
the primary tenant boundary; n8n Supabase nodes write/read outside it. Confirm which Supabase key
the n8n credential uses:
- If **service key** → it bypasses the new RLS entirely; every such node is only as safe as its
  hand-written filters (M1 is the live example).
- If **anon key** → RLS now blocks it and these nodes silently return nothing / fail to write.
*Recommendation:* route all n8n DB access through backend endpoints that enforce `clinic_id` scoping,
rather than direct Supabase nodes. Workflow 4's `Get Active Clinics` is the one legitimately
cross-clinic read and can stay.

---

## 3. Express API routes

| Route | File:line | Trust source for `clinic_id` | Verdict |
|---|---|---|---|
| `POST /onboarding/submit` | `onboarding.js:1330` | derived in RPC from validated payload; CORS+rate-limit+turnstile+honeypot | ✅ |
| `GET /onboarding/status/:clinicId` | `onboarding.js:1370` | URL param; returns provisioning status only, **no PII** | ⚠️ L3 (public per-clinic read on a UUID) |
| `POST /onboarding/:clinicId/go-live` | `onboarding.js:1404` | `verifyRequest` (secret + optional HMAC) + status guard | ✅ |
| `POST /internal/provision-callback` | `internal.js:1448` | `verifyRequest` | ✅ |
| `POST /webhooks/new-lead` | `leads.js:15` | **body `clinic_id`** + shared secret; validates clinic exists+active | ⚠️ **M2** |
| `POST /webhooks/appointment-cancelled` | `appointments.js:11` | body `appointment_id` + shared secret; **clinic derived from stored appointment** | ⚠️ M2 (secret scope) — clinic resolution itself ✅ |
| `POST /webhook/twilio/noshow`,`/reactivate` | `twilio.js:157,189` | **body, unauthenticated** | ❌ **H1/H2** |
| `GET /dashboard-api/stats` | `dashboard.js:899` | query `clinic_id`, or **all** if omitted; single shared password | ⚠️ L2 (by design; blocks per-clinic dashboards) |

**M2 — One shared secret is not a per-clinic identity.** `NEW_LEAD_WEBHOOK_SECRET` gates
`/webhooks/new-lead` and `/webhooks/appointment-cancelled`, and both accept a caller-asserted target
(`clinic_id` / `appointment_id`). A single leaked secret lets a caller create leads under any clinic
or cancel any clinic's appointment by UUID. `new-lead` validates the clinic exists+active but not
that the caller *is* that clinic; `appointment-cancelled` at least derives the clinic from the stored
row (good). *Fix:* issue per-clinic API keys (or per-clinic HMAC keys — the `twilio_number_sid`/key
ref now on `clinics` supports this) and reject a payload whose target clinic ≠ the key's clinic.
Short term: set `INTERNAL_HMAC_REQUIRED=true` and rotate the shared secret.

---

## 4. Every `.from(` on a clinic-owned table without a `clinic_id` filter

Reviewed all 60+ `.from(` sites (see `git grep "\.from('"`). Categorized:

**Correctly clinic-scoped** (filter by `clinic_id`): `getClinicByPhone`, `getOrCreateContact`,
`getOrCreateConversation`, `getDormantContacts`, `upsertLeadContact`, `getVipContacts`,
`findRecentConversation`, dashboard `_countIn`/`_apptsIn` (when `clinic_id` provided),
`getWaitingWaitlistByClinic`, `import-contacts.js` (requires `--clinic=<uuid>`, sets `clinic_id` on
every insert — `scripts/import-contacts.js:119,214`). ✅

**Scoped by PK or `contact_id` only — transitively safe, not defense-in-depth (L1):**
- `saveMessage` insert (`supabase.js:81`) — caller always supplies `clinic_id` (verified in
  `twilio.js`, `leadEngine.deliverMessage:15`). ✅ but relies on caller.
- `getConversationHistory` by `conversation_id` (`supabase.js:87`), `getContactById` (`:141`),
  `getAppointmentById` (`:645`), all `touch_schedule` update-by-id (`:278,284,290`),
  `getPendingTouchesForContact`/`getOfferedWaitlistByContact`/`getConfirmableAppointmentByContact`
  used in `handleInboundReply`. These read/write a single globally-unique row that was resolved
  inside a clinic context earlier, so they don't cross tenants in practice — but they carry **no**
  `clinic_id` predicate, so a bug upstream (wrong id) would not be caught. *Fix (defense-in-depth):*
  add `.eq('clinic_id', clinicId)` where the caller has it; cheap now that `(clinic_id, …)` indexes
  exist.

**Intentionally cross-clinic sweeps — correct per-row scoping (✅):** `getDueTouches` (`:299`),
`getNoShowCandidates` (`:679`), `getDueReminders24h/2h` (`:653,666`), `getExpiredOfferedWaitlist`
(`:734`), `getStaleVipTouches` (`:325`), `getActiveClinics` (`:133`). Every consumer re-loads the
clinic via `row.clinic_id` and checks `is_active` before acting — verified in
`server/jobs/sequenceScheduler.js:24-25,39`, `server/jobs/appointmentJob.js:12-15,38-39`,
`server/jobs/vipSweep.js:107-111`. `deliverMessage` always stamps `clinic_id` (`leadEngine.js:15`).
`offerSlotToWaitlist` scopes the waitlist to `appointment.clinic_id` (`appointments.js:29,33`). ✅

**Cross-clinic by design, password-gated (L2):** `getDashboardStats`/`getRecentMessages` return all
clinics when `clinic_id` omitted (`supabase.js:594,617`; `dashboard.js:899`). Fine for a solo
operator; a blocker for per-clinic logins. *Fix when the dashboard goes multi-tenant:* use the
`app_tenant` role + `set_config('app.current_clinic_id', …)` (provisioned in Phase 3) so RLS enforces
the scope instead of trusting the query param.

---

## 5. Vagaro `external_appointment_id` base64-vs-UUID mismatch (finding **V**)

Workflow 6's code node already documents it: Vagaro's `payload.appointmentId` is an internal
**base64** id (e.g. `"2dwfErtmMAFxe6hoCnQStw=="`), **not** the Supabase `appointments.id` UUID. It is
forwarded as-is, so `/webhooks/appointment-cancelled` → `getAppointmentById(appointment_id)`
(`supabase.js:645`) currently 404s. The fix is not yet implemented (there is **no**
`external_appointment_id` column anywhere — confirmed in Phase 1).

**The scoping requirement when the fix lands:** a Vagaro appointment id is only unique *within a
Vagaro account*, i.e. within one clinic. So a future lookup **must** be composite and clinic-scoped:
```
SELECT ... FROM appointments WHERE clinic_id = $1 AND external_appointment_id = $2
```
A global `WHERE external_appointment_id = $2` would risk cancelling the wrong clinic's appointment on
an id collision. But note: workflow 6 currently sends **no clinic context** at all (only
`appointment_id`). So the fix needs a Vagaro-account → clinic resolver first — mirror the existing
`lead_sources` pattern (a `vagaro` channel row mapping the Vagaro account/location id to a
`clinic_id`), have the webhook include that account id, resolve `clinic_id` from it, then do the
composite lookup. Add `appointments.external_appointment_id` with a **partial unique index on
`(clinic_id, external_appointment_id)`**, not a global unique.

---

## 6. Recommended fix order (for your approval — Phase 6)

1. **H1/H2** — authenticate `/noshow` + `/reactivate` (or delete them in favor of the backend crons)
   and bind contact→clinic. *Highest risk, smallest change.*
2. **M2** — per-clinic webhook credentials; interim `INTERNAL_HMAC_REQUIRED=true` + secret rotation.
3. **M1/M3** — retire/​re-scope the direct-DB n8n nodes; prefer backend endpoints.
4. **V** — implement the Vagaro id mapping with the composite clinic-scoped lookup + `lead_sources`
   style account resolver, before workflow 6 goes live.
5. **L1** — add redundant `clinic_id` predicates to the PK/contact-scoped queries.
6. **L2** — wire the dashboard to `app_tenant` + session var when it becomes multi-tenant.

No changes made. Tell me which of these to implement and I'll do them as a separate, reviewable Phase 6.
