# Phase 4 — migrations applied & validated

**Applied:** 2026-07-22, Supabase project `qakqwcyoeqkfqvgjibkv`, via the SQL Editor
(migration 4 run as the plain-index variant; see `20260721120300_tenant_indexes.sql`
header — `CONCURRENTLY` can't run in the editor's transaction).

## Migrations applied (in order)
1. `20260721120000_clinics_tenant_columns` — ✅
2. `20260721120100_clinic_id_backfill_guard` — ✅ (0 rows flagged)
3. `20260721120200_clinic_id_not_null` — ✅ (no NULLs; SET NOT NULL succeeded)
4. tenant indexes (plain variant) — ✅
5. `20260721120400_enable_rls_tenant_isolation` — ✅
6. `20260721120500_app_tenant_role` — ✅

## Validation (`supabase/VALIDATION.sql`) — all pass
| # | Proof | Result |
|---|---|---|
| 1 | Zero NULL `clinic_id` on every tenant table | ✅ |
| 2 | `clinic_id` NOT NULL at schema level (14 tables) | ✅ |
| 3 | RLS enabled **and** forced on all 14 tables | ✅ |
| 4 | No `USING (true)` catch-all policy anywhere | ✅ (0 rows) |
| 5 | `tenant_isolation` scoping every table by session `clinic_id` | ✅ |
| 6 | `app_tenant` cannot log in, cannot bypass RLS | ✅ |
| 7 | `clinics` has the 4 new columns | ✅ |
| 8 | `needs_manual_review` empty | ✅ |

## Independent REST cross-check (service key + anon key)
- NULL `clinic_id` across all tenant tables: **0**.
- `clinics.subscription_status` for the 4 existing clinics: all `active` (backfill correct).
- Anon key SELECT on `messages` / `clinics`: **0 rows** (RLS+FORCE effective).
- Service-role SELECT on `messages`: 48 rows (BYPASSRLS intact → Railway backend unaffected;
  live writes since the audit are all correctly clinic-scoped).

## Important follow-on (Phase 5)
The database now enforces isolation for every **non-service-role** connection. The Railway
backend still uses `service_role` (BYPASSRLS), so **application-layer `clinic_id` scoping on every
query remains the primary boundary today** — RLS is the second layer and only becomes the active
boundary for the dashboard once it uses `app_tenant` + `set_config('app.current_clinic_id', …)`.
Phase 5 audits whether the backend's own scoping is airtight.
