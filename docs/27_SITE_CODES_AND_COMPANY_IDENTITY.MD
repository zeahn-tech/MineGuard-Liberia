# 27 — Site codes and company identity (migration 0065)

## What changed
- **Site codes are allocated by the database.** Format `MGL-<county prefix>-<number, 4+ digits>`, e.g. `MGL-BOMI-0001`. A per-prefix counter row (`site_code_counters`) is incremented atomically inside a BEFORE INSERT trigger on `sites`; the app no longer computes codes. Existing codes are never rewritten; counters start at the current maximum per prefix.
- **A code is permanent** (`sites.code` cannot be updated). Ownership lives in `organization_id`; the company is not part of the code. A site that changes county keeps its code.
- **County is validated** against the 15 official counties on insert and on county change, through the frozen table `county_codes` (prefix = the first six letters the app always used, so every existing code stays valid): Bomi BOMI · Bong BONG · Gbarpolu GBARPO · Grand Bassa GRANDB · Grand Cape Mount GRANDC · Grand Gedeh GRANDG · Grand Kru GRANDK · Lofa LOFA · Margibi MARGIB · Maryland MARYLA · Montserrado MONTSE · Nimba NIMBA · River Cess RIVERC · River Gee RIVERG · Sinoe SINOE. Case, spaces and punctuation are ignored when matching. The register-site and company site-request forms now use a fixed dropdown.
- **Companies** have a Ministry licence number (mandatory for new companies, NULL for existing). Uniqueness is judged on the normalised form (uppercase, spaces and hyphens removed, `/` kept) and applies to pending, approved and suspended companies; only `deactivated` ones are excluded. Names are unique on a normalised form (letters and digits only, case-insensitive) under the same rule. Existing companies without a number appear on the registrar's to-do list. **Grace period:** they may keep **requesting** sites until a date held in ONE named setting, `platform_settings.licence_grace_until_for_site_requests` (default: 30 days after 0065 first runs; the default length is an assumption, change it before applying if you want a different one). Switch it off any time with `update public.platform_settings set value = null where key = 'licence_grace_until_for_site_requests';` (extend: set a later date, e.g. `'2027-01-31'`). A missing, blank, malformed or past value means OFF. Re-applying the migration never changes or extends the value. When the grace period is off they cannot **request** new sites until a number is added; their sites and operations are unaffected. The Ministry's own site registration is not blocked.
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
| A company administrator requests a site | Works for a company with a licence number, and for one without it while the grace period is on; a bad county fails with `INVALID_COUNTY`, and after the grace period a company without a licence fails with `LICENCE_REQUIRED` — shown generically by the old app. |

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
2. **Push-schema drift — one difference, between staging and (repo + production).** `push_subscriptions.user_id` references `profiles(id)` **with `ON DELETE CASCADE` on staging**, and **without it on production and in the repo** (0040 creates it plain, repo line `user_id uuid not null references public.profiles(id)`; production's constraint is `FOREIGN KEY (user_id) REFERENCES profiles(id)`). Everything else in the push schema matches (42 functions with grants, 8 triggers, 3 policies, 18 indexes, 6 tables, RLS/ACL). Production has **no** drift against the repo. It does **not** affect 0065 (0065 touches no push object). Practical effect, from the code: account deletion first marks the profile deleted (`deleted_at`); the scrub trigger then deletes the person's subscription rows unless an emergency-alert delivery still references them (those are anonymised and kept; production has 9 subscriptions, 3 referenced by deliveries). Only when the person has no records does the account-delete function try to remove the login (`profiles.id` cascades from `auth.users`); on production a kept subscription row would block that final delete, and the function then falls back to "anonymised" instead of "removed" (`handler.ts`: `if (!del.error) mode = "removed"`). So at worst a deleted account is anonymised rather than fully removed. Decide which behaviour is intended; to align staging with production use a staging-only change (drop and re-add the FK without cascade). Not changed here.

### Running the audit yourself (read-only, before production)
1. Supabase Dashboard → select the **production** project (check the project ref in the URL is `ewukneoblhogtreeekqc`) → **SQL Editor** → **New query**.
2. Paste the whole file `supabase/maintenance/site_code_prefix_audit_editor.sql` and click **Run**. It is a single SELECT: it cannot change anything.
   (With psql instead: `psql "$PRODUCTION_DATABASE_URL" -f supabase/maintenance/site_code_prefix_audit.sql`.)
3. Read the result table (columns: section, detail, result):
| Section | What a good result looks like |
|---|---|
| `0 overview` | `sites / companies / latest applied migration` shows your counts (production at last check: 9 / 12 / `0064`); `is 0065 already applied?` says `not applied (expected)`. |
| `1 prefixes in use` | One row per county prefix with its site count and highest number, e.g. `GBARPO  3 site(s), highest number 3`. Each becomes a counter starting at that number. A row `(not MGL-<LETTERS>-<digits>)` means odd old codes exist (left untouched, but tell me). |
| `2 counties as typed` | Each county as stored, ending `-> <PREFIX>`. Every line should resolve; `UNRESOLVED` means that spelling is not an official county. |
| `3 UNRESOLVED counties (expect none)` | **No rows.** Any row is a site whose county the new rule would refuse if someone edits its county (the site keeps working). |
| `4 code prefix differs from its county` | Informational; usually no rows. A row is a site that moved county and kept its code (allowed). |
| `5 code not MGL-<LETTERS>-<4+ digits> (expect none)` | **No rows.** Any row is an old-format code: it stays valid, but a strict format check could not be added later. |
| `6 company names that collide (expect none)` | **No rows.** Any row is two live companies with the same normalised name: 0065 would then skip the name index (with a WARNING) and the trigger would still block new duplicates. Resolve them first if you can. |
| `7 companies by status` | The count of companies per status (all have no licence number yet; they form the registrar to-do list). |
Stop and send me the output if sections 3, 5 or 6 show rows. Production at last check (read-only counts): 9 sites, 12 companies, no odd codes, no unresolved counties, no collisions.

### FINAL PRODUCTION RUNBOOK (numbered; production is NOT authorised until you say so)
**Before the window**
1. Confirm PR #80 is reviewed and approved, and the grace-period length (default 30 days) is what you want (edit the `+ 30` in the migration before applying if not).
2. Confirm production is still at 0001–0064 and identical to `main` (history fingerprint `ce580279549391ac6aad38e35e8e8d83` at last check) and that nothing else is waiting to deploy.
3. **Backup.** Dashboard → Database → Backups: note the latest backup time (and enable/confirm point-in-time recovery if your plan has it). Also take a manual dump: `pg_dump "$PRODUCTION_DATABASE_URL" --format=custom --file=mineguard_prod_before_0065_$(date +%F).dump`, then `pg_restore --list` on it to prove it reads. Store it securely.
4. Run the audit (section above). Continue only if sections 3, 5 and 6 are empty (or you accept what they show).
5. Announce the window; pick low traffic. The gap between steps 7 and 10 must be short (see the old-app table).
**Apply (production)**
6. SQL Editor on the production project (re-check the ref in the URL) → paste the whole `supabase/migrations/0065_site_code_hardening.sql` → Run. Expect success and no WARNING (a WARNING about the name index means legacy name collisions; the migration still succeeded).
7. Record it in the history: `insert into supabase_migrations.schema_migrations (version, name, statements) values ('0065','site_code_hardening', array['-- applied from supabase/migrations/0065_site_code_hardening.sql (PR #80)']);`
8. Run `supabase/maintenance/verify_0065_editor.sql`: every row must say PASS (row 8 may say REVIEW only if a WARNING appeared in step 6; row 9 shows the grace end date). Any FAIL → go to **Rollback A** now.
9. Spot check the counters: `select * from public.site_code_counters order by prefix;` — each number equals the highest number from audit section 1.
**Deploy**
10. Merge PR #80 (it auto-deploys). Watch the deploy finish.
**Post-deploy checks (no real data created unless you want to)**
11. Companies page (as the Ministry registrar): the Ministry licence number field is there; the "Companies without a licence number" list shows the existing companies and the grace end date; registering a company without a licence is refused with a clear message.
12. Register-site form (Ministry) and the company site-request form: County is a dropdown of the 15 counties.
13. When the next real site is registered, check its code continues the county's sequence (e.g. `MGL-GBARPO-0004`), and in SQL: `begin; update public.sites set code = code || 'X' where id = (select id from public.sites limit 1); rollback;` must fail with `CODE_IMMUTABLE`.
14. Registrar: enter a licence number for each company in the to-do list before the grace date. After that date company site requests for a company without a number are refused.
**Rollback**
- **Rollback A (before step 10, app not yet deployed):** run `supabase/maintenance/rollback_0065_site_code_hardening.sql`, then `delete from supabase_migrations.schema_migrations where version = '0065';`. Issued site codes stay valid. Nothing user-visible is lost.
- **Rollback B (after step 10):** revert the PR #80 merge commit and let it deploy (the app must stop sending licence numbers and stop expecting database codes), then run the rollback script and delete the history row. First export any licence numbers entered: `select id, name, licence_number from public.organizations where licence_number is not null;`. To go forward again later, re-apply 0065 (counters rebuild from the current maximum).
- Grace-period controls (no rollback needed): switch off `update public.platform_settings set value = null where key = 'licence_grace_until_for_site_requests';` · extend `... set value = '2027-01-31' ...`.

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
