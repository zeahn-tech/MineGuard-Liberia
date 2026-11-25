# 27 — Site codes and company identity (migration 0062)

## What changed
- **Site codes are allocated by the database.** Format `MGL-<county prefix>-<number, 4+ digits>`, e.g. `MGL-BOMI-0001`. A per-prefix counter row (`site_code_counters`) is incremented atomically inside a BEFORE INSERT trigger on `sites`; the app no longer computes codes. Existing codes are never rewritten; counters start at the current maximum per prefix.
- **A code is permanent** (`sites.code` cannot be updated). Ownership lives in `organization_id`; the company is not part of the code. A site that changes county keeps its code.
- **County is validated** against the 15 official counties on insert and on county change, through the frozen table `county_codes` (prefix = the first six letters the app always used, so every existing code stays valid): Bomi BOMI · Bong BONG · Gbarpolu GBARPO · Grand Bassa GRANDB · Grand Cape Mount GRANDC · Grand Gedeh GRANDG · Grand Kru GRANDK · Lofa LOFA · Margibi MARGIB · Maryland MARYLA · Montserrado MONTSE · Nimba NIMBA · River Cess RIVERC · River Gee RIVERG · Sinoe SINOE. Case, spaces and punctuation are ignored when matching. The register-site and company site-request forms now use a fixed dropdown.
- **Companies** have a Ministry licence number (mandatory for new companies, NULL for existing). Uniqueness is judged on the normalised form (uppercase, spaces and hyphens removed, `/` kept) and applies to pending, approved and suspended companies; only `deactivated` ones are excluded. Names are unique on a normalised form (letters and digits only, case-insensitive) under the same rule. Existing companies without a number appear on the registrar's to-do list and cannot **request** new sites until one is added; their sites and operations are unaffected. The Ministry's own site registration is not blocked.
- **Not changed:** Worker Voice / Ministry Voice site codes, CR- tracking codes.

## Deployment runbook
**Order:** backup → 0062 on a Supabase branch with a copy of production data → verify → production (low-traffic window) → deploy the app.
1. **Backup** production (point-in-time backup / `pg_dump`), note the time.
2. **Audit before touching anything** (read-only): `psql "$DATABASE_URL" -f supabase/maintenance/site_code_prefix_audit.sql`. Sections 3 and 5 should be empty; section 6 lists companies that already collide on name (then 0062 skips the name index with a WARNING and the trigger still blocks new duplicates).
3. **Staging branch with a copy of real data:** apply `0062_site_code_hardening.sql`, then run `supabase/maintenance/verify_0062.sql` (every line PASS), then the manual checks below. Re-apply 0062 once to confirm it is idempotent.
4. **Production:** apply 0062 (one transaction), run `verify_0062.sql`.
5. **Deploy the app** (merge to `main`) right after. Keep the window between steps 4 and 5 short.
6. **Registrar task, same day:** open Companies → "Companies without a licence number" and enter the Ministry licence number for each company. Until then, company administrators cannot request new sites (an intended consequence of the licence rule, not only a deploy-window effect).

### The old-app window (after 0062, before the new app is live)
| Old-app action | Result |
|---|---|
| Register a site (sends a client-computed `code`) | Works. A signed-in insert always gets a database-allocated code; the client's value is ignored, so even a stale or duplicate client code cannot collide (`0062` lines 153–155, `sites_code_guard`). **Cosmetic effect:** the old app writes its own audit-log summary ("Registered site <code> …", old `backend.ts` line 3441) and any message it shows using the code IT computed, which can differ from the stored code for sites registered in the window. The stored `sites.code` and the database audit row carry the real code; the Mining sites list shows it. |
| Approve a company site request | Works (it uses the same insert, then `mg_decide_site_request`, unchanged). |
| Demo seed | Works; same insert. Seeded sites get database codes. |
| Bulk import | Unaffected: it imports people against **existing** site codes and never creates sites. |
| County typed as free text | Case/spacing variants of an official county pass (`nimba`, `Grand  Gedeh`). A real mistake (`Grand Cape Mt`, `Bomi County`) is refused with `INVALID_COUNTY`; the old app shows its generic "We couldn't register the site" message with a reference, not the reason. Acceptable for the window; retype with the official name. |
| Register a company (old app sends only the name) | Fails with `LICENCE_REQUIRED` (accepted by decision); the old app shows a generic error. The new app has the licence field. |
| A company administrator requests a site | Fails (`LICENCE_REQUIRED`, and `INVALID_COUNTY` for a bad county) — shown generically by the old app. |

### Post-deploy verification
`supabase/maintenance/verify_0062.sql` checks: (1) counters ≥ current maximum per prefix, (2) no duplicate codes, (3) `sites_code_guard` and `organizations_identity_guard` present and enabled, (4) a code update is rejected (rolled back), (5) the new functions have no PUBLIC / anon execute and the internal helpers are not executable by `authenticated`, (6) `county_codes` / `site_code_counters` are not readable by client roles, (7) exactly 15 counties, (8) the unique indexes exist.
Manual: register one site as the Ministry in each of two counties → codes continue from the previous maximum; try to edit a code in SQL → `CODE_IMMUTABLE`; register a company with a licence number already in use → "already registered to …".

### Rollback
`supabase/maintenance/rollback_0062_site_code_hardening.sql` (data-safe for sites: issued codes stay valid; it drops the licence numbers and counters — export `select id, name, licence_number from organizations where licence_number is not null` first). Roll the app back at the same time (the 0062 app sends licence numbers and no site code). To go forward again, re-apply 0062: counters are rebuilt from the current maximum.

### Tests
In-memory PGlite (cannot reach any real database): `tests/site-code-hardening.test.ts`, `tests/site-code-idempotency.test.ts` (applies 0062 twice more with data), plus the adapted existing suites. Real parallelism: `tests/site-code-concurrency.pg.test.ts` spawns 50 `psql` sessions against a real Postgres; it only runs when `SITE_CODE_PG_URL` is set **and** passes `tests/helpers/disposable-pg.ts` (local host, database name containing test/scratch/disposable, not a Supabase/known-project URL, `SITE_CODE_PG_ALLOW_WRITES=yes`). The guard has its own test (`tests/disposable-pg-guard.test.ts`).

## Follow-ups (not in this branch)
1. **Licences table** — one company can hold several licences; this branch stores one primary licence number per company.
2. **Company registration number** (e.g. `MGC-000123`): database-generated at approval, unique, immutable, shown on company and site records. Separate branch; separate from the site code.
3. Tighten the soft licence-format rule once the Ministry confirms the official formats; consider a strict `CHECK` on site codes once the audit shows every existing code conforms.
