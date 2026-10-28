# 18 — Multi-company, site and workforce administration

Status: implemented on branch `feature/multi-company-admin` (migrations 0024–0029).
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
| Ministry `admin` (`organizations.write`) | register/approve a company; nominate company administrators; suspend/deactivate/reactivate with reason; manage any company's workforce; see all sites | — |
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

1. Staging first: apply `0024 → 0025 → 0026 → 0027 → 0028 → 0029` (idempotent), run
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

* In-app notifications for invitations / requests / role changes are not built
  (email only; the `notifications.kind` CHECK would need extending).
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
