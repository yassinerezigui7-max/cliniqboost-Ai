# Multi-Tenant Architecture Proposal — cliniqboost

**Phase 2 (design only).** No writes, no DDL executed. All SQL below is *illustrative* of what
Phase 3 migration files will contain, for your review — nothing here has been run.
Builds on [`AUDIT_REPORT.md`](AUDIT_REPORT.md). Decisions locked with you:

- **RLS strategy: Option B now, Option A later** (see §3).
- **`users`/`team_members` don't exist** — a staff model is proposed only as the Option-A bridge (§6).

---

## 1. Tenant root: `clinics` (confirm + extend, additively)

`clinics` already **is** the tenant root and every child table already FKs to it. We keep it —
we do **not** create a parallel tenants table. It already carries three independent lifecycle
signals, which we preserve rather than overload:

| Existing column | Axis | Meaning |
|---|---|---|
| `is_active` (bool) | **runtime gate** | `getClinicByPhone` only routes to active clinics; the live on/off switch |
| `onboarding_status` (text) | **provisioning lifecycle** | `created → awaiting_number → awaiting_booking_integration → ready → live (+ provisioning_failed)`; driven by `services/provisioning.js` |
| *(new)* `subscription_status` | **business lifecycle** | what the prompt calls status: `trial/active/paused/churned` |

Overloading `onboarding_status` with billing states would break `recomputeOnboardingStatus()` and
the go-live guard, so `subscription_status` is a **separate** additive column.

### 1a. Columns to ADD to `clinics` (all additive, nullable or defaulted)

```sql
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS subscription_status TEXT NOT NULL DEFAULT 'trial'
  CHECK (subscription_status IN ('trial','active','paused','churned'));
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS plan TEXT;              -- e.g. 'starter','pro'
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS go_live_at TIMESTAMPTZ; -- set at the go-live flip
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS twilio_number_sid TEXT; -- Twilio PN… SID (Phase-3 purchase)
```

**Alignment notes (reality, not invention):**
- **Twilio:** today the provisioned number is stored as `clinics.phone_number`; there is **no**
  number-SID column and no subaccount SID (number purchase is still feature-flagged off,
  `TWILIO_PROVISION_ENABLED=false`). `twilio_number_sid` is added now, left NULL, and populated
  when the Phase-3 purchase in `provisioning.js` lands. No subaccount-per-clinic column is proposed
  — the code doesn't use subaccounts.
- **HMAC "signing key ref":** there is **no per-clinic signing key**. `services/signing.js` signs
  every internal webhook with one shared `NEW_LEAD_WEBHOOK_SECRET`. I am **not** adding a column
  that implies otherwise. Making webhook writes a true per-tenant identity (audit finding **B5**) is
  deferred to §7 as an explicit future item (`clinic_webhook_secret`), not faked now.
- `go_live_at` is a new column; set it in the existing go-live handler alongside
  `is_active=true, onboarding_status='live'`.
- Existing per-clinic operational settings already live in `clinic_config` (1:1) — keep using it;
  no new settings table.

---

## 2. `clinic_id` on every clinic-owned table → `NOT NULL` + enforced FK

**Every existing row already has a non-NULL `clinic_id` (0 orphans, verified in Phase 1), so the
backfill is a verification step, not a data rewrite. No row is ever dropped.** Target end state per
table:

```sql
-- pattern, applied per tenant table:
clinic_id UUID NOT NULL REFERENCES clinics(id)
```

| Table | Today | Target | Backfill needed? |
|---|---|---|---|
| `contacts` | nullable FK | `NOT NULL` + validated FK | none (0 nulls) |
| `conversations` | nullable FK | `NOT NULL` + validated FK | none |
| `messages` | nullable FK | `NOT NULL` + validated FK | none |
| `missed_calls` | nullable FK | `NOT NULL` + validated FK | none |
| `appointments` | nullable FK | `NOT NULL` + validated FK | none |
| `revenue_metrics` | nullable FK | `NOT NULL` + validated FK | none (0 rows) |
| `touch_schedule` | nullable FK | `NOT NULL` + validated FK | none |
| `waitlist` | nullable FK | `NOT NULL` + validated FK | none (0 rows) |
| `onboarding_submissions` | nullable FK | `NOT NULL` + validated FK | none (RPC always sets it) |
| `provisioning_jobs` | nullable FK | `NOT NULL` + validated FK | none |
| `integration_tasks` | nullable FK | `NOT NULL` + validated FK | none |
| `lead_sources` | nullable FK | `NOT NULL` + validated FK | none (0 rows) |
| `import_jobs` | nullable FK | `NOT NULL` + validated FK | none (0 rows) |
| `clinic_config` | PK = `clinic_id` | already implicitly NOT NULL; add explicit FK validation | none |

**Backfill safety valve (design):** the Phase-3 backfill migration will, before any `SET NOT NULL`,
run a guard that writes any still-NULL `clinic_id` rows to a `NEEDS_MANUAL_REVIEW` audit table and
**abort** the `NOT NULL` step rather than guess ownership. Given 0 nulls today it will be a no-op,
but it stays in the migration so a re-run after new data is still safe.

---

## 3. RLS strategy — Option B now, engineered for Option A later

### The honest boundary model under Option B

The Railway backend connects with the **service-role key, which bypasses RLS entirely.** So RLS
policies do **not** constrain the current app's queries. That means:

> **Primary tenant boundary today = mandatory application-layer `clinic_id` scoping.**
> **RLS = defense-in-depth that activates for any *non*-service-role connection** (a leaked anon
> key, a future dashboard role, or the eventual Option A auth path).

Both layers ship. Concretely:

**Layer 1 — App layer (the actual enforcement now).**
- Introduce a single tenant-scoped data accessor so no route can forget the filter. Design: a thin
  `forClinic(clinicId)` wrapper around the Supabase client whose `.from(table)` auto-applies
  `.eq('clinic_id', clinicId)` on read/update/delete and injects `clinic_id` on insert, for the set
  of tenant tables. Routes that legitimately need cross-clinic access (cron sweeps, dashboard
  aggregate) call an explicit `acrossAllClinics()` escape hatch, so cross-tenant access is always
  visible and greppable. (Implementation = Phase 5 fixes; this proposal just fixes the shape.)
- `clinic_id` is always derived from a trusted source — the **receiving Twilio number**
  (`getClinicByPhone(To)`), the authenticated dashboard's chosen clinic, or a validated signed
  payload — **never** from an unauthenticated client body. (B5)

**Layer 2 — RLS on every tenant table (defense-in-depth).**

```sql
ALTER TABLE <tenant_table> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <tenant_table> FORCE ROW LEVEL SECURITY;   -- so even table owner is subject to it

-- Deny-by-default: no anon/authenticated policy at all = anon key reads nothing.
-- (This permanently closes the audit's B3/G2 anon-exposure class.)

-- Session-variable policy: a *non*-service connection is confined to one clinic
-- set per-request by the backend via set_config('app.current_clinic_id', <uuid>, true).
CREATE POLICY tenant_isolation ON <tenant_table>
  USING      (clinic_id = current_setting('app.current_clinic_id', true)::uuid)
  WITH CHECK (clinic_id = current_setting('app.current_clinic_id', true)::uuid);
```

- **No policy uses `USING (true)`.** The Phase-4 validation query will assert this.
- **`dashboard-rls-policies.sql` (the `USING(true)` footgun) is neutralized** in Phase 3 — replaced
  by a migration that drops those anon policies if present. (Currently inert on live, but it must
  not survive in a runnable state.)
- To make Layer 2 *bite* for the planned dashboard, add a dedicated least-privilege Postgres role
  `app_tenant` (SELECT-only on tenant tables, **not** service_role). The dashboard read path opens a
  transaction, `set_config('app.current_clinic_id', $clinicId, true)`, and queries as `app_tenant`.
  Then the *database itself* enforces per-clinic isolation for dashboard reads, independent of
  application code. This is the concrete "second layer, not the only layer" you asked for.

### Why Option B now (not A)

- The Railway backend is the **only writer**, already holds the service key, and every write path
  already threads `clinic_id`. Standing up Supabase Auth + JWT claims now adds an auth system with
  no user of it yet (no clinic staff log in today).
- Option B lets us close the highest-severity issues (nullable `clinic_id`, anon exposure, missing
  RLS-in-VCS) immediately with additive migrations and no auth migration.

### How this stays Option-A-ready

- The RLS predicate is written against a **claim source indirection**. Moving to Option A is then a
  policy swap, not a schema change:
  ```sql
  USING (clinic_id = coalesce(
           nullif(current_setting('app.current_clinic_id', true),'')::uuid,      -- Option B (backend session var)
           (auth.jwt() ->> 'clinic_id')::uuid));                                 -- Option A (Supabase Auth claim)
  ```
- Add the staff table (`clinic_users`, §6) when Option A arrives; it maps `auth.uid()` → `clinic_id`
  for the JWT claim. Not created now (no rows would use it).

---

## 4. Indexing plan

Every tenant table gets a `clinic_id` index; dashboard/report hot paths get composites so a
100-clinic table still seeks by tenant + time.

```sql
-- fill the gaps found in Phase 1:
CREATE INDEX IF NOT EXISTS idx_messages_clinic          ON messages(clinic_id);
CREATE INDEX IF NOT EXISTS idx_revenue_metrics_clinic   ON revenue_metrics(clinic_id);

-- composites for the dashboard's (clinic_id + created_at window) queries:
CREATE INDEX IF NOT EXISTS idx_messages_clinic_created      ON messages(clinic_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_missed_calls_clinic_created  ON missed_calls(clinic_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_appointments_clinic_created  ON appointments(clinic_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contacts_clinic_created      ON contacts(clinic_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_appointments_clinic_status   ON appointments(clinic_id, status);
```

- Existing single-column `clinic_id` indexes (`contacts`, `conversations`, `missed_calls`,
  `appointments`, `touch_schedule`, `waitlist`, onboarding tables) are kept; the composites cover
  the dashboard filters. Redundant single-column indexes can be pruned later (non-urgent, non-destructive to leave).
- All created with `CREATE INDEX CONCURRENTLY` in Phase 3 (outside a txn) to avoid write locks on
  live tables.

---

## 5. Naming / cleanup ("messy dashboard") — safe changes only

**No table renames or data migrations are required or recommended.** The mess is behavioral, not
structural, and the fixes are additive:

| Item | Action | Risk |
|---|---|---|
| `dashboard-rls-policies.sql` `USING(true)` anon policies | Phase-3 migration drops them if present; delete the file | none (inert now); removes a footgun |
| Dashboard cross-tenant aggregate (`clinic_id='all'`) | Keep as an **explicit** operator-only path behind `acrossAllClinics()`; gate future customer dashboards to a single `clinic_id` via the `app_tenant` role (§3) | none structurally; it's an app-layer + role change |
| Redundant single-column `clinic_id` indexes after composites land | Optional later cleanup | none (leaving them is safe) |
| `clinics` "hot row" vs settings | Already split: operational settings in `clinic_config`. Keep. | none |
| `schema.sql` TEST clinic seed / drift | Fold real structure into versioned migrations; stop relying on `schema.sql` as truth | none |

Anything that would require a **data** migration (e.g. splitting a table, changing a PK): **none
identified.** Everything above is additive DDL, index builds, RLS, and app-layer changes.

---

## 6. Future: staff/team model (Option-A bridge) — NOT built now

When per-clinic dashboard logins are wanted, add:

```sql
CREATE TABLE clinic_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID NOT NULL REFERENCES clinics(id),
  auth_user_id UUID NOT NULL,        -- = auth.uid() from Supabase Auth
  role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('owner','staff','viewer')),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (clinic_id, auth_user_id)
);
```

This is the table the Option-A JWT claim resolves against. It is intentionally **not** in the
Phase-3 migrations — it has no users yet and would be dead schema. Listed so the path is explicit.

---

## 7. Deferred / explicitly out of scope for Phase 3

- **B5 real per-tenant webhook identity** — replace the single shared `NEW_LEAD_WEBHOOK_SECRET` with
  a per-clinic `clinic_webhook_secret` so a leaked secret can't write into every clinic. Design
  later; touches `signing.js` and n8n. Noted, not built now.
- **Vagaro `external_appointment_id`** — the column doesn't exist yet (Phase-1 G8). When added it
  must be **`UNIQUE (clinic_id, external_appointment_id)`**, never globally unique, so two clinics
  can hold the same Vagaro id. Phase 5 tracks the base64/UUID fix.
- **Option A auth** — schema is made ready (§3, §6); the auth system itself is a later project.

---

## Migration ordering that Phase 3 will follow (preview)

1. `clinics` additive columns (§1a).
2. Per-table: (already have `clinic_id`) → add validated FK `NOT VALID` then `VALIDATE`.
3. Backfill guard + `NEEDS_MANUAL_REVIEW` (no-op today) → then `SET NOT NULL` per table.
4. Indexes `CONCURRENTLY` (§4).
5. Enable/force RLS + `tenant_isolation` policies on every tenant table (§3).
6. Drop the `USING(true)` anon policies; create the `app_tenant` role.
7. A `ROLLBACK.md` per migration.

Each file: idempotent (`IF EXISTS`/`IF NOT EXISTS`), **zero** `DROP TABLE`/`DROP COLUMN`/`TRUNCATE`,
re-runnable.

---

## STOP — awaiting your approval before Phase 3 (writing migration SQL)

Per your gates, I will not write any migration files under `supabase/migrations/` until you approve
this proposal. Two small confirmations that would sharpen Phase 3:

1. **`app_tenant` role (§3, Layer 2):** OK to include the least-privilege dashboard role now, or
   defer it until the customer dashboard is actually built? (Including it now is what makes RLS a
   real second layer rather than latent.)
2. **`subscription_status` default:** default new clinics to `'trial'` (proposed) — confirm, or
   should existing 4 clinics be set to `'active'` in the same migration?
