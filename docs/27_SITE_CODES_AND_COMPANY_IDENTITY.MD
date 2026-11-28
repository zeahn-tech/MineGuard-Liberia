# 27 — Site codes and company identity (migration 0065)

## 1. What changed
- **Site codes are allocated by the database.** Format `MGL-<county prefix>-<number>`, e.g. `MGL-BOMI-0001`. The number is zero-padded to **four digits up to 9999 and written in full from 10000 on** (`MGL-SINOE-9999`, then `MGL-SINOE-10000`). A per-prefix counter row (`site_code_counters`) is incremented atomically inside a BEFORE INSERT trigger on `sites`; the app no longer computes codes. The format check accepts 4 to 9 digits. Existing codes are never rewritten; counters start at the current maximum per prefix.
- **A code is permanent** (`sites.code` cannot be updated). Ownership lives in `organization_id`; the company is not part of the code. A site that changes county keeps its code.
- **The county is validated and stored canonically.** The 15 official counties live in the frozen table `county_codes` (prefix = the first six letters the app always used, so every existing code stays valid): Bomi BOMI · Bong BONG · Gbarpolu GBARPO · Grand Bassa GRANDB · Grand Cape Mount GRANDC · Grand Gedeh GRANDG · Grand Kru GRANDK · Lofa LOFA · Margibi MARGIB · Maryland MARYLA · Montserrado MONTSE · Nimba NIMBA · River Cess RIVERC · River Gee RIVERG · Sinoe SINOE. Matching ignores case, spaces, digits and punctuation, and the county is **stored as the canonical name** (`bomi`, `Bo-mi!!`, `Bo1mi` → `Bomi`; ` GRAND   bassa` → `Grand Bassa`), on insert, on a county change, and in company site requests. Only a non-county (`Atlantis`) is refused. Legacy rows keep their spelling. The register-site and site-request forms are a fixed dropdown.
- **Owner-run loads** (SQL editor, seeds, restores; no signed-in user) may supply a code, but it must be well formed **and carry the prefix of the site's own county**; nothing is written to the counters unless it does.
- **Companies:** a Ministry licence number is mandatory for new companies (NULL for existing ones). Rules: 5–30 characters after removing spaces and hyphens, letters/digits/`/` only, at least one digit, never `APL-…` (application number) or `CLC-…` (category code); an unrecognised shape is a warning only. Uniqueness is judged on the normalised form (uppercase, spaces and hyphens removed, `/` kept) and on a normalised name (letters and digits only, case-insensitive), across pending, approved and suspended companies; only `deactivated` ones are excluded.
- **Licence integrity (guard on every write):** the licence is validated on every insert and change, even by direct SQL; a client role (authenticated/anon) can never change it by direct update; an existing number changes only through `mg_set_company_licence` **with a reason** (stored with who and when in `licence_change_reason/at/by`, and recorded by the existing organizations audit trail); it can never be cleared back to NULL.
- **Companies created from owner-run site inserts** (an unknown operator name) are created **pending review**, flagged in `status_reason`, never approved, and appear on the registrar to-do list. Signed-in sessions still get `UNKNOWN_COMPANY`. An owner-run seed that really wants approved demo companies says so explicitly: `select set_config('mg.seed_mode', 'on', true);` in its own transaction. Affected flows: SQL loads/restores/seeds that insert sites with an operator name that is not yet a company (test fixtures that did this now register the company first). Not affected: the app's own `runSeed` (it runs as a signed-in admin and already required registered companies).
- **Grace period:** companies with no licence number may keep **requesting** sites until the date in ONE named setting, `platform_settings.licence_grace_until_for_site_requests` (a real date `YYYY-MM-DD`). The 30-day default is written **only when the setting table is first created**; if the row is later deleted, re-applying the migration does not bring it back. A missing, blank, malformed or past value means OFF. A bad date is refused at write time with a clear message (`INVALID_SETTING`), and if a bad value ever got in, requests are refused as "off" with a message that names the unusable setting. **Every change is audited** (who, when, before and after, in `audit_log`). After the grace period, such companies cannot request sites until a number is recorded; their existing sites and operations are never affected.
- **Not changed:** Worker Voice / Ministry Voice site codes, CR- tracking codes.

Change the grace period with SQL **after** applying (never by editing the audited migration file):
```sql
update public.platform_settings set value = '2027-01-31' where key = 'licence_grace_until_for_site_requests';  -- set / extend
update public.platform_settings set value = null          where key = 'licence_grace_until_for_site_requests';  -- switch off
```

## 2. Environment state and the staging rehearsal
| Environment | Applied migrations | Note |
|---|---|---|
| Repo `main` | 0001–0064 | 0062–0064 are the push migrations (PR #81). |
| Production (`ewukneoblhogtreeekqc`) | 0001–0064, identical to `main` (history fingerprint match at last check) | 0062–0064 were applied from the **reconstructed** files. **0065 is not applied.** |
| Staging (`iwmgrcfmgqldrdkplbtr`) | 0001–0064 + the amended 0065 (rolled back and re-applied, see below) | Staging ran the original push files. A registry-only copy of production (12 companies, 9 sites) is loaded; its reference data tables are empty. |

0065 touches no push object; the only function shared with the push work is `mg_notify` (7-argument signature, unchanged).

**Rehearsal after the re-audit (staging only; scenarios ran as signed-in or owner-run sessions inside rolled-back transactions):** rolled back the earlier 0065 (history ended at 0064, 9 sites and 12 companies intact) and re-applied the amended file; `verify_0065_editor.sql` all PASS. Results: company without licence / one-argument old call → `LICENCE_REQUIRED`; `APL-123` → `INVALID_LICENCE`; `MEL 2111/16` accepted; duplicate licence (`mel-2111/16`) and duplicate name (`staging test ONE!`) refused; unrecognised-but-valid format accepted (warning only); preview flags three near matches; registrar adds a licence, a change **without** a reason is refused, **with** a reason it is stored with who/why; clearing to NULL, `APL-12345`, `!!!###$$$ 99`, `NODIGITS` by direct SQL all refused; sites in Nimba/Lofa continue the copied sequence (`MGL-NIMBA-0003`, `MGL-LOFA-0001`, `MGL-NIMBA-0004`); an old-app insert sending `MGL-NIMBA-0001` is stored as `MGL-NIMBA-0005`; `bomi`, `Bo-mi!!`, `Bo1mi`, ` GRAND   bassa` stored as `Bomi`/`Bomi`/`Bomi`/`Grand Bassa`; a county change to `  river-cess ` stored as `River Cess`; counter at 9998 → `MGL-SINOE-9999`, `-10000`, `-10001`; owner-run wrong-prefix and junk-prefix codes refused with no stray counter row; `Grand Cape Mt` and `Narnia` refused; every `sites.code` update (alone and with county + operator) refused; owner-run insert with a new operator → pending review, no licence, on the to-do list; signed-in unknown operator → `UNKNOWN_COMPANY`; the seed path yields an approved demo company; site requests: grace on → accepted (county stored canonically), `Atlantis` refused, grace ended yesterday → refused, last day accepted, switched off → refused, with a licence → accepted; `2027-13-45` refused at write time with a clear message; the setting changes appear in `audit_log`.
**Not provable on staging:** real parallelism (the connector is one session; 50 parallel sessions, including across 9999, pass on a local PostgreSQL 16 — `tests/site-code-concurrency.pg.test.ts`), and behaviour on messy real data (production's own audit is clean).

## 3. PRODUCTION RUNBOOK (one list; production is NOT authorised until you say so)
**Before the window**
1. PR #80 reviewed and approved; the default grace length (30 days from the first apply) is acceptable — you can change it by SQL afterwards (section 1).
2. Confirm production is still at 0001–0064 and identical to `main`, and nothing else is waiting to deploy.
3. **Backup.** Dashboard → Database → Backups: note the latest backup time (and point-in-time recovery if your plan has it). Take a manual dump: `pg_dump "$PRODUCTION_DATABASE_URL" --format=custom --file=mineguard_prod_before_0065_$(date +%F).dump`, then `pg_restore --list` on it to prove it reads. Store it securely.
4. **Run the audit** (read-only): Dashboard → the **production** project (URL must show `ewukneoblhogtreeekqc`) → SQL Editor → paste `supabase/maintenance/site_code_prefix_audit_editor.sql` → Run. (psql alternative: `psql "$PRODUCTION_DATABASE_URL" -f supabase/maintenance/site_code_prefix_audit.sql`.) Read it:
| Section | A good result |
|---|---|
| `0 overview` | counts as expected (last known: 9 sites / 12 companies / latest `0064`); `is 0065 already applied?` = `not applied (expected)` |
| `1 prefixes in use` | one row per county prefix with its site count and highest number (each becomes a counter start); a row `(not MGL-<LETTERS>-<digits>)` = odd old codes (untouched; tell me) |
| `2 counties as typed` | every county ends `-> <PREFIX>`; `UNRESOLVED` = not an official county spelling |
| `3 UNRESOLVED counties (expect none)` | **no rows** (a row = a site whose county could not be re-entered if edited; it keeps working) |
| `4 code prefix differs from its county` | informational; usually none (a site that moved county keeps its code) |
| `5 code not MGL-<LETTERS>-<at least 4 digits> (expect none)` | **no rows** |
| `6 company names that collide (expect none)` | **no rows** (otherwise the name index is skipped with a WARNING; the trigger still blocks new duplicates) |
| `7 companies by status` | counts per status (none has a licence yet: the registrar to-do list) |
   Stop and send me the output if sections 3, 5 or 6 show rows. (Production at last read-only check: 9 sites, 12 companies, no odd codes, no unresolved counties, no collisions.)
5. Announce the window; low traffic. Keep the gap between steps 8 and 11 short (section 4).

**Apply (production)**
6. SQL Editor on production (re-check the project ref) → paste the whole `supabase/migrations/0065_site_code_hardening.sql` → Run. Expect success and no WARNING (a WARNING about the name index = legacy name collisions; the migration still succeeded).
7. Record it: `insert into supabase_migrations.schema_migrations (version, name, statements) values ('0065','site_code_hardening', array['-- applied from supabase/migrations/0065_site_code_hardening.sql (PR #80)']);`
8. **Verify:** run `supabase/maintenance/verify_0065_editor.sql`. Every row must say PASS. REVIEW rows are explained by the text (legacy counties/codes/prefixes that you already saw in the audit). Any FAIL → **Rollback A**. (psql users: `psql "$DATABASE_URL" -f supabase/maintenance/verify_0065.sql` from the repo root also runs the write probes, which roll back.)
9. Spot check: `select * from public.site_code_counters order by prefix;` — each number equals the highest number from audit section 1. `select * from public.platform_settings;` shows the grace date.

**Deploy**
10. Merge PR #80 (auto-deploys). Watch the deploy finish.

**Post-deploy**
11. UI checks (no real data needed): Companies page — licence field, to-do list with the grace date; registering a company without a licence is refused with a clear message; register-site and site-request forms show the county dropdown.
12. Run the **post-deploy query set** (section 6) once, and again after the first real site is registered (its code must continue the county's sequence, e.g. `MGL-GBARPO-0004`).
13. Registrar: enter a licence number for every company on the to-do list before the grace date. Companies auto-created by owner-run inserts show as "pending review".

**Rollback**
- **Rollback A (before step 10, app not deployed):** run `supabase/maintenance/rollback_0065_site_code_hardening.sql`, then `delete from supabase_migrations.schema_migrations where version = '0065';`. Issued codes and canonical counties stay. It restores the pre-0065 functions verbatim; proven to return a database to the exact pristine-0064 schema (same 1,122-object fingerprint).
- **Rollback B (after step 10):** revert the PR #80 merge commit and let it deploy (the app must stop sending licence numbers and expecting database codes), then run the rollback script and delete the history row. First export what would be lost: `select id, name, licence_number, licence_change_reason, licence_changed_at from public.organizations where licence_number is not null;` and `select * from public.platform_settings;`. `audit_log` rows written by 0065 are append-only and stay. Re-applying 0065 later rebuilds counters from the current maximum.

## 4. The old-app window (after step 8, before step 11)
| Old-app action | Result |
|---|---|
| Register a site (sends a client-computed `code`) | Works. A signed-in insert always gets a database-allocated code (the `sites_code_guard` trigger); the client's value is ignored, so a stale or duplicate client code cannot collide. **Cosmetic:** the old app writes its own audit summary ("Registered site <code> …") from the code IT computed, which can differ from the stored code; the stored `sites.code` and the database audit row carry the real one. |
| Approve a site request / demo seed | Works (same insert path; approval itself is unchanged). |
| Bulk import | Unaffected (it imports people against existing site codes and never creates sites). |
| County typed as free text | Case/spacing/punctuation variants of an official county pass and are stored canonically. A real mistake (`Grand Cape Mt`, `Bomi County`) is refused (`INVALID_COUNTY`); the old app shows its generic "We couldn't register the site" message, not the reason. Retype with the official name. |
| Register a company (old app sends only the name) | Fails with `LICENCE_REQUIRED` (accepted); generic message in the old app. |
| Company administrator requests a site | Works for a company with a licence, and for one without it while the grace period is on; a bad county fails; after the grace period a company without a licence fails (generic message in the old app). |

## 5. Break-glass: bypassing the immutability or licence guards
Only the table owner can do this (`ALTER TABLE … DISABLE TRIGGER`). It needs a **named reason, a ticket and an approver**, and it must write an audit entry **before and after**. Use one transaction, change one thing, and run verification afterwards. (Tested, rolled back, on a scratch database.)
```sql
begin;
-- 1. MANDATORY audit entry BEFORE touching the guard
insert into public.audit_log (actor_id, actor_label, action, entity_type, entity_id, summary, details)
values (null, 'break-glass: <your name>', 'break_glass.trigger_disabled', 'trigger', 'sites_code_guard',
        '<one-line reason and ticket>',
        jsonb_build_object('reason', '<why>', 'ticket', '<id>', 'approved_by', '<name and role>', 'database_user', session_user));
-- 2. disable, make ONE minimal change, enable again
alter table public.sites disable trigger sites_code_guard;      -- licence guard: public.organizations / organizations_licence_guard
update public.sites set code = '<corrected code>' where code = '<mistyped code>';
alter table public.sites enable trigger sites_code_guard;
-- 3. MANDATORY audit entry recording what changed
insert into public.audit_log (actor_id, actor_label, action, entity_type, entity_id, summary, details)
values (null, 'break-glass: <your name>', 'break_glass.trigger_enabled', 'trigger', 'sites_code_guard',
        'guard re-enabled; changed <old> to <new> (<ticket>)', jsonb_build_object('before', '<old>', 'after', '<new>', 'ticket', '<id>'));
commit;
```
4. **Afterwards run `verify_0065_editor.sql`** (all PASS; rows 3 and 15 confirm the guards are enabled and the codes consistent) and keep the two audit entries with the ticket. A code changed this way must also be changed on any printed sign or QR that carries it. Never leave a guard disabled: `select tgname, tgenabled from pg_trigger where tgname in ('sites_code_guard','organizations_licence_guard');` must show `O` (enabled).

## 6. Monitoring, alert recommendations and the post-deploy query set
**Alerts to configure** (Supabase → Logs Explorer saved queries / your log drain; thresholds are suggestions):
| Signal | Why | Suggested alert |
|---|---|---|
| Postgres log lines containing `INVALID_COUNTY` | an old client or a typo; a burst means a form regressed | more than 20 in 10 minutes |
| `CODE_IMMUTABLE`, `CODE_PREFIX_MISMATCH`, `INVALID_CODE_FORMAT` | someone or something tried to change or forge a code | any occurrence |
| Allocator trouble: `integer out of range`, `canceling statement due to statement timeout` or lock timeouts mentioning `mg_allocate_site_code` / `site_code_counters` | the counter or its row lock is misbehaving | any occurrence |
| `LICENCE_CLEAR_BLOCKED`, `LICENCE_VIA_FUNCTION_ONLY`, `REASON_REQUIRED` | attempts to bypass the licence rules | any occurrence (a few `REASON_REQUIRED` from registrars are normal) |
| `INVALID_SETTING` | someone tried to write a bad grace date | any occurrence |
| `audit_log` rows with `action like 'platform_settings.%'` or `'break_glass.%'` | the grace setting or a guard was changed | notify the owner on every row |
| Grace period ends within 7 days while companies still lack a licence | registrars must act | email/Slack on the day |
Logs Explorer example: `select timestamp, event_message from postgres_logs where event_message like '%CODE_IMMUTABLE%' or event_message like '%INVALID_COUNTY%' order by timestamp desc limit 100` (check the table name in your dashboard).

**Post-deploy query set** (all read-only; run in the SQL editor):
```sql
-- 1 counters vs codes (counter must be >= the highest code number per prefix)
select c.prefix, c.last_number as counter, max(((regexp_match(s.code, '^MGL-[A-Z]+-([0-9]+)$'))[1])::bigint) as highest_code
  from public.site_code_counters c left join public.sites s on s.code like 'MGL-' || c.prefix || '-%' group by c.prefix, c.last_number order by 1;
-- 2 no duplicate codes, and no code with a short number part
select code, count(*) from public.sites group by code having count(*) > 1;
select code from public.sites where code ~ '^MGL-[A-Z]+-[0-9]{1,3}$';
-- 3 counties not in canonical spelling (legacy rows are expected; new ones must not appear)
select county, count(*) from public.sites where county not in (select county from public.county_codes) group by county;
-- 4 invalid licence numbers (must be none) and companies still without one
select name, licence_number from public.organizations where licence_number is not null
   and (upper(btrim(licence_number)) ~ '^(APL|CLC)[[:space:]]*-' or length(regexp_replace(licence_number, '[[:space:]-]', '', 'g')) not between 5 and 30
        or regexp_replace(licence_number, '[[:space:]-]', '', 'g') !~* '^[A-Z0-9/]+$' or licence_number !~ '[0-9]');
select name, status, status_reason from public.organizations where licence_number is null and status <> 'deactivated' order by status, name;
-- 5 licence changes and their reasons
select name, licence_number, licence_change_reason, licence_changed_at, licence_changed_by from public.organizations where licence_changed_at is not null order by licence_changed_at desc limit 50;
-- 6 the grace setting and who changed it
select key, value, updated_at from public.platform_settings;
select created_at, actor_label, summary from public.audit_log where entity_type = 'platform_settings' order by created_at desc limit 20;
-- 7 guard triggers enabled ('O' = enabled)
select tgname, tgenabled from pg_trigger where tgname in ('sites_code_guard','organizations_identity_guard','organizations_licence_guard','platform_settings_guard','platform_settings_changelog');
-- 8 break-glass entries (should be none unless approved)
select created_at, actor_label, summary from public.audit_log where action like 'break_glass.%' order by created_at desc;
```

## 7. Accepted risks
- **Unicode lookalikes (F-8):** company names are compared on letters and digits; a Cyrillic "А" and a Latin "A" are different letters, so two names that look identical can both be registered. Licence numbers are restricted to ASCII letters, digits and `/`, so lookalikes cannot enter them. Accepted: the registrar's possible-duplicate preview and human review are the control.
- **O versus 0 and similar (F-8):** licence numbers are compared after normalisation only; `MEL 2111/16` and `MEL 2lll/16` or `O` for `0` are different numbers. Accepted; the format warning and human review catch most.
- **Licence with and without the slash (F-8):** `MBL 1008/14` and `MBL 100814` normalise differently and can both exist. Accepted until the Ministry confirms the official shapes (the soft format check already warns).
- **Counter lock held until commit (F-10):** allocating a code locks that county's counter row until the registering transaction commits, so concurrent registrations in the same county queue behind each other. Registrations are short, and a rolled-back registration releases the number with no gap; a very long transaction that registers a site would delay others in the same county. Accepted; different counties never contend.
- The pre-0065 app cannot show the reason for a refused county (section 4).

## 8. Findings from the rehearsal that are NOT caused by this change
1. **Staging reference data is empty** (`permissions` has 0 rows on staging and 32 on production; admin areas/boundaries, risk config, retention policy, templates, meta are empty too), so permission-gated functions refuse on staging unless a permission is inserted (the rehearsal did that inside rolled-back transactions). Not loaded here by decision.
2. **Push-schema drift, one difference between staging and (repo + production):** `push_subscriptions.user_id` references `profiles(id)` with `ON DELETE CASCADE` on staging, without it on production and in the repo (0040 creates it plain). It does not affect 0065; the practical effect is limited to whether a deleted account is anonymised or fully removed. Decide separately.

## 9. Tests and scripts
- In-memory database (cannot reach any real one): `tests/site-code-hardening.test.ts`, `tests/site-code-audit-findings.test.ts` (one test per re-audit finding), `tests/site-code-idempotency.test.ts` (re-applying, including after the grace setting was deleted).
- Real PostgreSQL parallelism: `tests/site-code-concurrency.pg.test.ts` (50 parallel sessions, and across the 9999 boundary). Runs only against a disposable local database through `tests/helpers/disposable-pg.ts` (`SITE_CODE_PG_ALLOW_WRITES=yes`, host local, database name containing test/scratch/disposable, never a Supabase URL); the guard is covered by `tests/disposable-pg-guard.test.ts`.
- Scripts: `supabase/maintenance/site_code_prefix_audit(_editor).sql`, `verify_0065(_editor).sql`, `rollback_0065_site_code_hardening.sql`.

## 10. Follow-ups (not in this change)
1. A licences table: one company can hold several licences; this change stores one primary licence number per company.
2. A company registration number (e.g. `MGC-000123`): database-generated at approval, unique, immutable, shown on company and site records; a separate branch, separate from the site code.
3. A screen for registrars to correct a licence with a reason (the function and API support it; the screen only enters a first number today).
4. Tighten the soft licence-format rule once the Ministry confirms the official formats; consider a strict site-code `CHECK` once an audit shows every existing code conforms.
