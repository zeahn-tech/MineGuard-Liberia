# 19 — Site status board and map status (Phase 1)

Status: implemented on branch `phase1-national-dashboard`. No database migration.

## What it is
A per-site status board on the command center and a status summary/filter on the
national map. Everything shown is what the signed-in user's own database session
may already read (Row Level Security); nothing is widened and no service
credentials are used.

## Rules (src/lib/site-status.ts — the whole methodology)
First match wins:
1. **Requires immediate review** — an open critical finding, or a non-closed
   incident with a fatality or critical severity.
2. **Corrective action overdue** — an outstanding action is past its due date.
3. **Information insufficient** — no approved inspection on record.
4. **Data stale** — latest approved inspection is older than 180 days.
5. **Recent information available** — latest approved inspection is within 180 days.

There is **no "safe" or "compliant" status and no composite score**. A site with
no reports is "Information insufficient", never safe. Open critical findings,
overdue actions and serious incidents are always listed, whatever the status.
"Verified" means an approved inspection; incident/submission times are
company-submitted and may be unreviewed.

## Staleness window — APPROVED: 180 days
Approved by the project owner on 2026-11-01 (about one inspection every six
months). It only decides when a site moves between "Recent" and "Stale". Change
`STALE_AFTER_DAYS` in `src/lib/site-status.ts` and update tests/site-status.test.ts.

## Data minimization
The feed (`api.stats.siteStatusFeed`) selects only the columns the rules need —
never descriptions, notes, answers, evidence, or reporter/inspector identities.

## Known limits
- "Data read" time is when this device last read the database, not a field-sync time.
- There is no separate regulator role; government access is the admin/supervisor/
  inspector roles plus a scope.
- The feed pages through all visible rows on the client (fine at current scale).
- Visual/mobile layout needs browser testing; automated tests cover structure and content.

## Rollback
Revert the commit. There is no database state to undo.

## Related
Audit finding E1 (cross-scope UPDATE policies) is fixed separately by migration
0035 on branch `fix/e1-site-scoped-update-policies`; merge and apply it first.
