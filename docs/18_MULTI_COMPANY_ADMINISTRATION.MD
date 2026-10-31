# 18 — Multi-company, site and workforce administration

Status: implemented on branch `feature/multi-company-admin` (migrations 0024–0034).
**Not applied to any live database.** Phase E (bulk CSV onboarding + the dedicated
Onboarding officer role) is built; see §10.

## 1. Architecture assessment (what existed, what was reused)

| Concern | Reused as-is | Added |
|---|---|---|
| Identity | Supabase Auth, `profiles` | — |
| Platform role | `profiles.role` (`admin`/`supervisor`/`inspector`/`operator`) | — (company roles live in membership) |
| Tenant | `organizations`, `profiles.organization_id`, `sites.organization_id` | `organizations.status` |
| Permissions | `permissions` + `mg_has_permission` (`organizations.write`) | — |
| Site access | `mg_can_access_site_row`, `site_assignments` | per-site rule; soft revoke |
| Audit | `mg_touch_row` / `mg_audit_row` triggers | attached to the new tables |
| Notifications | — | email invitations only (see Remaining) |

New tables (necessary because no equivalent existed): `organization_members`
(one live membership per user, `org_role`, status) and `organization_invitations`
(no stored secret). A membership **request** is a `pending` member row.

## 2. Roles and permission rules

| Actor | Can | Cannot |
|---|---|---|
| Ministry `admin` (`organizations.write` + `workforce.oversee`) | register/approve a company; nominate company administrators; suspend/deactivate/reactivate with reason; manage any company's workforce; see all sites | — |
| Company administrator (active, company **approved**) | invite worker / safety officer / site manager; decide join requests; change roles; remove members; assign people to sites; see all company sites | appoint administrators; touch another company; change own role / remove self; act while company is suspended |
| Site manager | see only assigned sites; assign **workers/safety officers** to **their** sites; read that site's roster | see unassigned sites; assign site managers or themselves; invite; change roles |
| Worker / safety officer | company-wide access until assigned; once assigned, only assigned sites | any administration |
| Anyone | request to join an approved company (cooldown 24 h after a decline) | bind themselves to a company by typing its name |

Government permissions are separate: a company account can never receive
`admin`/`supervisor`/`inspector` through any of these flows (checked on invite,
accept, request and approve).

## 3. Invitations (Supabase email)

Ministry or company administrator → `company-admin-invite` edge function →
database RPC authorizes the **caller** → only then the service-role client sends
the Supabase invite (or a one-time sign-in link if the address already has an
account). No token is stored: acceptance needs the invitee's own **verified**
email to match the invited address. Expiry 7 days, revoke, resend throttle
(60 s, max 10 sends), single use, indistinguishable errors for unknown / foreign /
used invitations, redirect URL fixed by server configuration.

## 4. Company and site status policy

* Company `pending_review | approved | suspended | deactivated`. Only
  `organizations.write` changes it; suspend/deactivate require a recorded reason.
* A company that is not `approved` loses operator access to site-scoped records
  and its administrators lose workforce powers; the Ministry keeps full oversight;
  nothing is deleted; reactivation restores everything.
* Site `status` stays an operational registry status (it does **not** hide records:
  operators must still file corrective actions on a suspended site).

## 5. RLS / access-matrix changes (exact)

1. `0024` — profile tenant guard: a non-admin can never change their own
   `operator_name`/`organization_id`; `complete_staff_profile` no longer writes them.
   Fixes cross-tenant takeover by typing a company name (reproduced, regression-tested).
2. `0025` — `mg_can_access_site_row`: operator's company must be `approved`.
3. `0026` — members/invitations readable by the Ministry or the company's own
   administrators; all writes only through definer RPCs.
4. `0027` — `mg_can_access_site_row`: per-site rule from §2; revoked assignments
   never count; extra read policy on `site_assignments` for company managers.

## 6. Deployment order (required)

GitHub Pages deploys the **frontend** on merge to `main` and never applies
migrations. Therefore:

1. Staging first: apply `0024 → 0025 → 0026 → 0027 → 0028 → 0029 → 0030 → 0031 → 0032 → 0033 → 0034` (0030 must be its own run: it adds the `registrar` enum value, which PostgreSQL cannot use in the same transaction) (idempotent), run
   `supabase/checks/migration_state.sql`.
2. Deploy the `company-admin-invite` function; secrets `INVITE_REDIRECT_URL`
   (the site ROOT — the app uses a hash router, so the email link cannot carry a
   path; a signed-in invitee with a waiting invitation is routed to `/invitation` automatically) and `INVITE_ALLOWED_ORIGIN`; add the URL to the Auth
   redirect allow-list; configure SMTP + invite template; keep "confirm email" ON.
3. Only then merge to `main`. (The frontend tolerates a database that is behind:
   the layout treats a missing membership RPC as "no membership".)
4. Review `supabase/maintenance/review_unreviewed_org_claims.sql` (read-only).

### 6a. Email and test accounts

Supabase's built-in mailer allows only a few emails per hour per project and is
shared by sign-up confirmations, password resets and invitations — once it is used
up, confirmation emails silently stop. Production needs **custom SMTP**.
To test without waiting: Dashboard → Authentication → Users → Add user → Create
new user → tick **Auto Confirm User**; or run
`update auth.users set email_confirmed_at = now() where email = '<address>';`.
Invitations deliberately require a VERIFIED email, so an unconfirmed self-signed
account cannot accept one.

## 7. Rollback

* Frontend: revert the merge. No data depends on it.
* `0027`: restore 0025's `mg_can_access_site_row` and 0026's `mg_revoke_member`; drop
  `profiles_ensure_membership`, the three site-people functions and the extra policy.
* `0026`: drop its functions/policies; restore 0025's invitation functions/policies.
* `0025`: drop the RPCs, the two tables and the three `organizations` status columns;
  restore 0010's `mg_can_access_site_row`.
* `0024`: re-apply 0010's `complete_staff_profile`; drop `profiles_self_tenant_guard`
  (this reopens the tenant-takeover hole — only for a deliberate downgrade).

## 8. Tests

`tenant-binding`, `company-invitations`, `company-invite-function`,
`company-workforce`, `company-sites`, `company-release-order`, plus the pinned
surfaces in `migration-apply` (table/trigger counts, execute allow-list, policy
count). Every authorization claim above has a negative test that attempts the
bypass directly against the database as the attacker's role.

## 9. Remaining / unverified

* UI pages were typechecked and built but not exercised in a browser; the edge
  function was exercised through its pure handler, not on Deno; real invite-email
  delivery is untested.
* A worker's company-wide default (until scoped) is a deliberate compatibility
  choice; a stricter "unassigned workers see nothing" policy is a one-line change
  in `mg_operator_site_ok` once every worker has been scoped.
* Government-side per-company drill-down (company → sites → records) reuses the
  existing staff portal; no new regulator dashboard was added.

## 10. Phase E — Onboarding officer and bulk import (migration 0029)

**Dedicated role `onboarding_officer`** (company level, appointed only by a company
administrator or the Ministry, by invitation):

| Can | Cannot |
|---|---|
| run bulk imports; invite workers / safety officers; resend or revoke those invitations; read the workforce list | approve join requests; change roles; remove people; assign sites; invite site managers, officers or administrators; read ANY site or safety record (the per-site rule gives the role no site) |

**Bulk import** (`/operate/import`, company administrators and officers): CSV
columns `email` (required), `role` (`worker`|`safety_officer`, blank = worker),
`full_name`, `site_code` (optional; the invitee is assigned that site on accepting).

1. Browser: parse, size (<= 1 MB), row cap (<= 2000), header and per-row checks (fast feedback only).
2. Server dry run per 100 rows (`mg_import_check`): existing members, pending invitations, unknown sites, administrative roles — nothing is written.
3. Import (`mg_import_start` keyed by a client idempotency key, then `mg_import_apply` in batches of <= 100): each row number is processed at most once; the unique pending-invitation index prevents duplicates; a re-sent batch returns the recorded outcomes.
4. Emails are a separate queue (`company-admin-invite` import mode, <= 20 per call); a failed send is released back to the queue (`mg_release_invitation_send`) so retries are not throttled.

An import creates **pending invitations only** — no account, no membership, no
administrative role (`company_admin`, `site_manager`, `onboarding_officer` rows are
row errors). Addresses that are government accounts or members of another company
all read "This address cannot be invited" (no cross-company disclosure). Spreadsheet
formula injection is neutralised in the downloadable problem report.

Rollback: drop the new functions/tables/policies and the `site_id` column; restore
the 0026/0027/0028 definitions of the replaced functions; re-add the role CHECKs
without `onboarding_officer` (only after removing officers).

## 11. The dedicated Ministry role: Company registrar (migrations 0030 + 0031)

For a licensing / authorization office that should approve companies **without**
being a full platform administrator.

| A registrar CAN | A registrar CANNOT |
|---|---|
| register + approve a company | read any site, incident, inspection, finding, corrective action or audit record |
| nominate a company's FIRST administrator; resend / revoke those invitations | read other people's profiles, or manage accounts, roles, boundaries, templates |
| suspend / deactivate / reactivate a company (reason required) | see or change any company's workforce: members, join requests, roles, imports, site people |
| see the company directory: status, site COUNT, administrators, invitation state, member and request COUNTS | invite workers, officers or site managers; become a company user by any route (invite, request, accept, import) |

How it is enforced: the role holds exactly one permission, `organizations.write`.
Workforce oversight, which `admin` previously had implicitly through that same
permission, is now its own permission `workforce.oversee` (admin only), and
`mg_can_manage_company` tests it — so `admin` behaves exactly as before and the
registrar does not inherit company internals. The directory
(`mg_company_directory`) lists administrators individually and counts everyone
else, so no worker identity reaches the registry screen.

Assigning: a full admin picks **Company registrar** in the *Assign platform role*
dialog of the staff portal (scope is locked to national), or run `supabase/maintenance/assign_company_registrar.sql`
in the SQL Editor (the person must have signed up, and must not belong to a company).
The registrar signs in to `/registry`, which shows the Companies screen only.

Rollback: restore the 0026 `mg_can_manage_company` and the 0029/0026/0028 versions of
the invitation, accept, request, decide and import-eval functions; drop
`mg_company_directory`; delete the registrar and `workforce.oversee` permission rows;
set `profiles.role = null` for registrars. (The enum value stays; PostgreSQL cannot
drop one and it is harmless.)

### 11a. Government roles never hold a company (migration 0032)

Whatever the route — the dialog, `provision_user_by_email`, a direct admin update, or
the owner-run script — a profile that becomes `admin`, `supervisor`, `inspector` or
`registrar` has its company binding cleared, and (when the role actually changes) its
pending/active company memberships revoked and its site assignments in those
companies ended. A registrar is always national scope. Nothing is deleted. Re-saving
the same government role changes nothing, so staff site assignments survive.

## 12. Mining sites ↔ Companies (migration 0033 + screens)

**Two screens, one link.** *Mining sites* lists SITES (one row per site); *Companies*
lists COMPANIES (including ones with no site yet). A company that has accepted its
invitation but has no registered site appears on Companies only. They are joined by
the company id every site carries.

* **A — companies are registered, never typed.** The Register site form now offers a
  dropdown of registered, approved companies (no free-text name). In the database
  (`mg_resolve_organization`, `mg_sync_site_org`) a signed-in session can no longer
  create a company by typing a name — `UNKNOWN_COMPANY` — and a new site needs an
  approved company — `COMPANY_NOT_APPROVED`. This also closes the same hole in the
  admin "Assign platform role" dialog. Existing data is untouched; owner-run SQL
  (no signed-in user) keeps the old behaviour for maintenance and seed scripts.
* **B — company filter on Mining sites**, kept in the address (`?company=<id>`); the
  Operator column is now "Company" and links (admins) to the company page.
* **C — company detail** (`/portal/companies/:id`, admins): the company card
  (administrators, invitations, status controls, counts) plus the company's sites,
  each linking to the existing site page. Worker names are not shown; the registrar's
  registry cards do not link (the registrar has no site access).

Rollback: restore the 0010 `mg_resolve_organization` / `mg_sync_site_org`; the screens
degrade gracefully.

## 13. In-app notifications and the registrar's account security (migration 0034)

**Notifications** reuse the 0021 inbox (private per user; content immutable; read /
dismiss state one-way). They are created BY THE DATABASE from the events themselves
(triggers), so every route — the screens, the API, SQL, bulk import — produces them:

| Event | Who is notified | Opens |
|---|---|---|
| invitation created | the invitee, if they already have an account (otherwise the email is their notice) | `/invitation` |
| invitation accepted | whoever sent it | `/registry`, the company page, or Team |
| join request | the company's administrators (that company only) | Team |
| request approved / declined | the requester | `/operate` / `/join` |
| role changed, removed | the member | `/operate` / `/join` |
| company status changed | the company's administrators | `/operate` |
| site status changed | the company's administrators | Sites |

Text carries company names and role labels only — never an email address, an
invitation link or any secret. A failure while notifying logs a warning and **never
blocks** the action that caused it. A notification can only link inside the app. Email
remains the channel for people without an account; no push/SMS exists. (Site
*registration requests from companies* are not a workflow yet, so there is nothing to
notify.) The bell appears in the staff, operator and registry headers.

**Registrar account security**: `/registry/security` — the same password and
authenticator (MFA) page the operator and staff use.

Rollback: drop the four `*_notify*` triggers and their functions; restore the 0021
guard and the two notification CHECK constraints.
