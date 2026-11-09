# 23 — Public content, the public area and the account dashboard [IMPLEMENTED — migration 0050]

Part of the Public User programme (Phase D). Rule: **the public reads only what the Ministry explicitly
approved and published.** Nothing is public because it exists in the app, an API or the frontend.

## What is public
| Kind | Where it appears |
|---|---|
| `glossary_term` | `/public/glossary` (search + category filter) |
| `safety_guidance` | `/public/safety` |
| `announcement` | `/public/notices`, latest three on `/public` |
| `statistics` | approved figures on `/public`, `/account` and the landing page |

The company/site directory is **not** public: `mg_search_companies` returns only the id and name of
approved companies to verified accounts, and nothing marks any company or site field as approved for
release. Revisit only when the Ministry defines approved public fields (and company consent), published
through this same lifecycle.

English only. The schema carries a `language` and `translation_of` link for future reviewed translations;
no French content exists, none is shown, and none is claimed.

## Lifecycle
`draft → pending_review → approved → published → archived`, one function (`mg_content_transition`).

* **Authors and reviewers:** administrators and supervisors (permissions `content.author`, `content.review`).
  **Publishers:** administrators only (`content.publish`).
* **Four-eyes:** nobody approves content they wrote or last edited. An approval records a note
  (10+ characters) and the reviewer's confirmation of **accuracy, completeness and confidentiality**.
* Only drafts are editable. Approved, published and archived content is immutable (a database trigger
  enforces it too). To change published content: *Revise* → new draft version → review → publish; the old
  version is archived automatically.
* Returning content to draft and archiving both need a written reason. Every step is recorded in
  `public_content_events` (actor, note, checks) and the audit log.
* Optional `publish_at` / `expires_at` schedule visibility.

## Read path and safety
* Anyone, with no session, can read published, in-date rows through **column grants** (public columns only);
  provenance notes, authors and editors are unreadable by every client, administrators included.
* No client has any write grant. Staff reads and all writes go through definer functions that check their permission.
* Bodies render as **plain text paragraphs** — never HTML or markdown.
* Statistics are human-approved snapshots (label, number, as-of date; 1–12 figures). Nothing is computed live.
  The earlier anonymous live counts (all-company sites, inspections, incidents, reports) were **retired**:
  `meta` is no longer readable by anon or by non-staff.

## The existing glossary
The 229 terms in `src/data/safety-reference.ts` come from an outside field-app data file whose review stamp
records no sign-off. `scripts/gen-public-glossary-seed.mjs` prepares them as **drafts** in
`supabase/seeds/public_glossary_drafts.sql` (not a migration; `--check` fails CI if stale). Loading it
publishes nothing. Reviewers work through them in *Portal → Public Content*. The first-aid, PPE, tips and
immediate-action content is **not** imported: the Ministry writes public safety guidance in the editor after
qualified review (first-aid steps are medical guidance).

## Who sees what
* **Everyone / guests:** `/public/*` (read-only).
* **Registered public users:** `/account` (dashboard), `/account/reports`, `/account/feedback`,
  `/account/profile`, `/account/security`; the report form with opt-in linking.
* **Staff reviewers:** *Portal → Public Content* and *Public Feedback*.
* Public users and guests are no longer parked on a staff gate after sign-in: guests go to `/public`, public
  accounts to `/account`. This is routing only; the database decides access.

## Rollout (nothing here is applied automatically)
1. Apply 0047 → 0048 → 0049 → 0050 in order (see `14_DEPLOYMENT_OPERATIONS.MD` for the 0047 prerequisites).
2. Optional: run `supabase/seeds/public_glossary_drafts.sql` once as the project owner.
3. Reviewers review, approve and publish. Until something is published the public pages show honest empty states.
4. Rollback: `supabase/maintenance/rollback_0050_public_content.sql` (loses all content and history, and
   re-opens the anonymous live statistics).
