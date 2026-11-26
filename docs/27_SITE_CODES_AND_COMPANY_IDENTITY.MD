# 27 — Site codes and company identity (migration 0065)

## What changed
- **Site codes are allocated by the database.** Format `MGL-<county prefix>-<number, 4+ digits>`, e.g. `MGL-BOMI-0001`. A per-prefix counter row (`site_code_counters`) is incremented atomically inside a BEFORE INSERT trigger on `sites`; the app no longer computes codes. Existing codes are never rewritten; counters start at the current maximum per prefix.
- **A code is permanent** (`sites.code` cannot be updated). Ownership lives in `organization_id`; the company is not part of the code. A site that changes county keeps its code.
- **County is validated** against the 15 official counties on insert and on county change, through the frozen table `county_codes` (prefix = the first six letters the app always used, so every existing code stays valid): Bomi BOMI · Bong BONG · Gbarpolu GBARPO · Grand Bassa GRANDB · Grand Cape Mount GRANDC · Grand Gedeh GRANDG · Grand Kru GRANDK · Lofa LOFA · Margibi MARGIB · Maryland MARYLA · Montserrado MONTSE · Nimba NIMBA · River Cess RIVERC · River Gee RIVERG · Sinoe SINOE. Case, spaces and punctuation are ignored when matching. The register-site and company site-request forms now use a fixed dropdown.
- **Companies** have a Ministry licence number (mandatory for new companies, NULL for existing). Uniqueness is judged on the normalised form (uppercase, spaces and hyphens removed, `/` kept) and applies to pending, approved and suspended companies; only `deactivated` ones are excluded. Names are unique on a normalised form (letters and digits only, case-insensitive) under the same rule. Existing companies without a number appear on the registrar's to-do list and cannot **request** new sites until one is added; their sites and operations are unaffected. The Ministry's own site registration is not blocked.
- **Not changed:** Worker Voice / Ministry Voice site codes, CR- tracking codes.

## Deployment runbook

### Environment state (verified read-only via the Supabase connector, 2026-11-25)
| Environment | Applied migrations | Note |
|---|---|---|
| Repo `main` | 0001–0064 | 0062–0064 are the push migrations (PR #81). |
| Production (`ewukneoblhogtreeekqc`) | 0001–0064 | 0062–0064 were applied from the **reconstructed** files in PR #81 (their header says "RECONSTRUCTED from the live staging schema"). |
| Staging (`iwmgrcfmgqldrdkplbtr`) | 0001–0064, empty database (no rows) | 0062–0064 were applied earlier from the **original** files, which are not in the repo (their recorded sizes/hashes differ from the reconstructions). |

This migration is therefore **`0065_site_code_hardening.sql`** (it was 0062 until the push migrations took 0062–0064). It touches none of the push objects: the three push files reference no `sites`, `organizations`, `county_codes`, `site_code_counters`, `mg_request_site` or `mg_register_company`; the only function shared with this change is `mg_notify` (called by `mg_request_site`), whose 7-argument signature is the same on staging.
**Known drift to close separately:** staging ran the original push SQL, production/repo the reconstruction. A read-only schema comparison of the push objects (tables, functions, triggers, policies, grants) between the two projects should be done before relying on staging as a rehearsal of production for the push features.

### Staging checklist (staging only; production NOT authorised)
1. Confirm project = `iwmgrcfmgqldrdkplbtr`, status ACTIVE_HEALTHY, and `list_migrations` ends at 0064 with nothing after.
2. Read-only audit: `site_code_prefix_audit.sql` (expected: all sections empty — staging has no data).
3. Apply `0065_site_code_hardening.sql` as migration version `0065`, name `site_code_hardening`. Expect no errors and no WARNING (no legacy name collisions on an empty database).
4. `verify_0065.sql`: every check PASS (counters, no duplicate codes, both triggers enabled, code update rejected, no anon/PUBLIC execute, internal helpers closed, tables closed, 15 counties, both unique indexes).
5. Manual behaviour checks (create a throwaway registrar user and company admin first; staging is empty): register a company **without** a licence → `LICENCE_REQUIRED`; **with** `MEL 2111/16` → ok; again with `mel2111/16` and another name → `DUPLICATE_LICENCE`; with `APL-123` → `INVALID_LICENCE`; as a company administrator of a company with no licence, request a site → `LICENCE_REQUIRED`; create sites in two counties (e.g. Nimba and Lofa) as the Ministry → `MGL-NIMBA-0001` and `MGL-LOFA-0001`, then a second Nimba site → `MGL-NIMBA-0002`; `update sites set code = 'X'` → `CODE_IMMUTABLE`; an unknown county → `INVALID_COUNTY`.
6. Re-apply the file once: no error, counters and codes unchanged.
7. Record every result (including errors) in the PR. Leave the test rows (sites are never deleted).
8. Production only after: the staging results above, a production backup, the read-only audit on production, and your explicit go-ahead.
**Order:** backup → 0065 on staging (checklist above) → verify → production (low-traffic window) → deploy the app. A staging project with no data cannot prove behaviour on messy real data; use a copy of production data as well if you can.
1. **Backup** production (point-in-time backup / `pg_dump`), note the time.
2. **Audit before touching anything** (read-only): `psql "$DATABASE_URL" -f supabase/maintenance/site_code_prefix_audit.sql`. Sections 3 and 5 should be empty; section 6 lists companies that already collide on name (then 0065 skips the name index with a WARNING and the trigger still blocks new duplicates).
3. **Staging branch with a copy of real data:** apply `0065_site_code_hardening.sql`, then run `supabase/maintenance/verify_0065.sql` (every line PASS), then the manual checks below. Re-apply 0065 once to confirm it is idempotent.
4. **Production:** apply 0065 (one transaction), run `verify_0065.sql`.
5. **Deploy the app** (merge to `main`) right after. Keep the window between steps 4 and 5 short.
6. **Registrar task, same day:** open Companies → "Companies without a licence number" and enter the Ministry licence number for each company. Until then, company administrators cannot request new sites (an intended consequence of the licence rule, not only a deploy-window effect).

### The old-app window (after 0065, before the new app is live)
| Old-app action | Result |
|---|---|
| Register a site (sends a client-computed `code`) | Works. A signed-in insert always gets a database-allocated code; the client's value is ignored, so even a stale or duplicate client code cannot collide (`0065` lines 153–155, `sites_code_guard`). **Cosmetic effect:** the old app writes its own audit-log summary ("Registered site <code> …", old `backend.ts` line 3441) and any message it shows using the code IT computed, which can differ from the stored code for sites registered in the window. The stored `sites.code` and the database audit row carry the real code; the Mining sites list shows it. |
| Approve a company site request | Works (it uses the same insert, then `mg_decide_site_request`, unchanged). |
| Demo seed | Works; same insert. Seeded sites get database codes. |
| Bulk import | Unaffected: it imports people against **existing** site codes and never creates sites. |
| County typed as free text | Case/spacing variants of an official county pass (`nimba`, `Grand  Gedeh`). A real mistake (`Grand Cape Mt`, `Bomi County`) is refused with `INVALID_COUNTY`; the old app shows its generic "We couldn't register the site" message with a reference, not the reason. Acceptable for the window; retype with the official name. |
| Register a company (old app sends only the name) | Fails with `LICENCE_REQUIRED` (accepted by decision); the old app shows a generic error. The new app has the licence field. |
| A company administrator requests a site | Fails (`LICENCE_REQUIRED`, and `INVALID_COUNTY` for a bad county) — shown generically by the old app. |

### Staging rehearsal — 2026-11-25 (staging `iwmgrcfmgqldrdkplbtr` only; production untouched)
**Data used:** a registry-only copy of production (12 companies and 9 sites: names, statuses, codes, counties, locations). No profiles, emails or reports were copied; a placeholder account satisfies `created_by`. Production's own audit was clean (no non-standard codes, no unresolved counties, no company name collisions), so this proved the migration on real-shaped data but not on messy data.
**Applied:** `0065` (executable statements of the file; comment lines omitted from the executed text; recorded in staging's history as `0065 site_code_hardening`). No errors, no WARNING.
**Result on the copied data:** counters initialised exactly to the maximum per prefix (BONG 1, GBARPO 3, GRANDB 2, NIMBA 2, SINOE 1); all 9 existing codes unchanged; both unique indexes created; 0 of 12 companies have a licence number (the registrar to-do list). Verification checks 1, 2, 3, 5, 6, 7, 8 all PASS (check 4, the immutability probe, was exercised as B6/B7 below).
**Behaviour (each run as a signed-in user inside a transaction that was rolled back; staging unchanged afterwards):**
| Step | Result |
|---|---|
| Register company without licence / one-argument (old client) call | refused: `LICENCE_REQUIRED` |
| Licence `APL-123` | refused: `INVALID_LICENCE` (cadastre application number) |
| Register with `MEL 2111/16` | accepted |
| Same licence as `mel-2111/16` under another name | refused: `DUPLICATE_LICENCE` (names the holder) |
| Same name as `staging test MINING one!` | refused: `DUPLICATE_ORGANIZATION` |
| Valid licence in an unrecognised format (`XYZ-12345`) | accepted (soft warning only) |
| Preview for "Nimba Builder sand" | three near matches flagged `similar_name` |
| Registrar adds a licence to a copied company; same number on another | accepted; second refused |
| Sites: Nimba, Lofa, Nimba again | `MGL-NIMBA-0003`, `MGL-LOFA-0001`, `MGL-NIMBA-0004` (continuing from the copied 0001/0002) |
| Old-app insert sending an existing code `MGL-NIMBA-0001` | accepted, stored as `MGL-NIMBA-0005` (client code ignored) |
| County `Grand Cape Mt` / update to `Narnia` | refused: `INVALID_COUNTY` |
| Update `sites.code` (alone, and with county + operator) | refused: `CODE_IMMUTABLE` |
| Update another column of a copied legacy row | accepted |
| Ten sequential Grand Kru sites | `MGL-GRANDK-0001`..`0010`, all distinct |
| Company admin without licence requests a site | refused: `LICENCE_REQUIRED` |
| After licence added: county `Atlantis` / `Nimba` | refused `INVALID_COUNTY` / accepted |
**Not tested here:** real parallelism (the connector runs one session; the 50-way parallel test passed on a local PostgreSQL 16) and re-applying the file on staging (idempotency is covered by `tests/site-code-idempotency.test.ts` and was run on local PostgreSQL).

### Findings from the rehearsal (not caused by 0065)
1. **Staging reference data is empty.** `permissions` (production: 32 rows), `admin_areas`, `admin_boundaries`, `meta`, `risk_config_versions`, `voice_retention_policy`, `inspection_templates` all have 0 rows on staging, so every permission-gated function refuses there (the registrar tests needed `organizations.write` inserted inside a rolled-back transaction). Staging's migrations are recorded as applied but its reference/seed rows were never loaded; staging is not a functional copy of production until they are.
2. **Push-schema drift, one difference** (everything else matched: 42 functions with grants, 8 triggers, 3 policies, 18 indexes, 6 tables, RLS/ACL): `push_subscriptions.user_id` references `profiles(id)` **with `ON DELETE CASCADE` on staging** (original 0062/0063/0064 files) but **without it on production and in the repo** (0040 defines it plain; the reconstructed 0062 says it does not change the table shape). Decide which is intended and fix with a separate migration; it is not part of this PR.

### Post-deploy verification
`supabase/maintenance/verify_0065.sql` checks: (1) counters ≥ current maximum per prefix, (2) no duplicate codes, (3) `sites_code_guard` and `organizations_identity_guard` present and enabled, (4) a code update is rejected (rolled back), (5) the new functions have no PUBLIC / anon execute and the internal helpers are not executable by `authenticated`, (6) `county_codes` / `site_code_counters` are not readable by client roles, (7) exactly 15 counties, (8) the unique indexes exist.
Manual: register one site as the Ministry in each of two counties → codes continue from the previous maximum; try to edit a code in SQL → `CODE_IMMUTABLE`; register a company with a licence number already in use → "already registered to …".

### Rollback
`supabase/maintenance/rollback_0065_site_code_hardening.sql` (data-safe for sites: issued codes stay valid; it drops the licence numbers and counters — export `select id, name, licence_number from organizations where licence_number is not null` first). Roll the app back at the same time (the 0065 app sends licence numbers and no site code). To go forward again, re-apply 0065: counters are rebuilt from the current maximum.

### Tests
In-memory PGlite (cannot reach any real database): `tests/site-code-hardening.test.ts`, `tests/site-code-idempotency.test.ts` (applies 0065 twice more with data), plus the adapted existing suites. Real parallelism: `tests/site-code-concurrency.pg.test.ts` spawns 50 `psql` sessions against a real Postgres; it only runs when `SITE_CODE_PG_URL` is set **and** passes `tests/helpers/disposable-pg.ts` (local host, database name containing test/scratch/disposable, not a Supabase/known-project URL, `SITE_CODE_PG_ALLOW_WRITES=yes`). The guard has its own test (`tests/disposable-pg-guard.test.ts`).

## Follow-ups (not in this branch)
1. **Licences table** — one company can hold several licences; this branch stores one primary licence number per company.
2. **Company registration number** (e.g. `MGC-000123`): database-generated at approval, unique, immutable, shown on company and site records. Separate branch; separate from the site code.
3. Tighten the soft licence-format rule once the Ministry confirms the official formats; consider a strict `CHECK` on site codes once the audit shows every existing code conforms.
