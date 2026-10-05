# 04 — Security Architecture

**Status:** implemented controls below; gaps listed honestly.

**Backend note (2026-09-24):** the authorization boundary moved from Firebase
security rules to PostgreSQL RLS + guard triggers + security-definer RPCs in
`supabase/migrations/0001_initial_schema.sql`. The model below is unchanged in
intent; the enforcement technology is now Postgres. The prior committed-secret
(0.1), tenant-isolation (0.2) and role-blind storage (0.3) defects from the
Firebase era are structurally closed: profiles are admin-writable only via
trigger, every evidence/finding/CA read goes through `mg_can_access_site()`,
and storage reads join the metadata row by path before granting access.

## Principles applied [IMPLEMENTED]

- **Least privilege.** Four roles; access helpers in both the database
  (`mg_is_staff()`, `mg_is_reviewer()`, `mg_is_admin()`, `mg_can_access_site()`)
  and the data layer (`requireStaffUser`, `requireReviewerUser`,
  `requireAdminUser`, operator isolation).
- **Defense in depth.** Route guard (RequireAuth) + Postgres RLS policies and
  guard triggers (authoritative server boundary) + identical checks re-derived
  in `src/lib/backend.ts` before every operation + scope filtering inside
  queries + audit logging.
- **Server-side authorization.** RLS derives every permission from
  `public.profiles` (admin-writable only via the `profiles_guard` trigger). The
  client never grants access; hiding UI is cosmetic only.
- **Geographic access control.** County-scoped staff can only read/write records
  in their county (`mg_can_access_site()` in every scoped policy; mirrored in
  the data layer).
- **Tenant isolation.** Operators match sites by exact `operator_name`; they can
  only acknowledge findings and respond to corrective actions on their own
  sites, enforced by guard triggers and data layer alike.
- **Secure sessions.** Supabase Auth (email/password + anonymous guest); session
  tokens managed by the platform (GoTrue), `auth.uid()` available to every RLS
  policy and RPC.
- **Audit logging.** Append-only `audit_log` written by the data layer inside
  every consequential mutation; insert policy only — no update/delete policy
  exists, so Postgres denies by default under RLS.
- **Input validation.** TypeScript-typed function arguments in the data layer;
  Postgres enums for statuses, severities, categories, verification states (the
  database rejects anything outside the closed unions); check constraint caps
  evidence at 25MB; the public RPC rate-limits submissions.
- **No secrets in client code.** Supabase URL + anon key are public by design;
  authorization never depends on their secrecy. The service-role key never
  reaches the frontend; any future privileged work goes through security-definer
  RPCs.

## File access [IMPLEMENTED — scoped reads]

Evidence bytes live in a **private** Supabase Storage bucket `evidence` under
`{uid}/{evidenceRowId}__{fileName}`. The upload policy requires the first path
folder to equal `auth.uid()` and the account to hold a role; the read policy
re-derives the caller's role/tenant from `public.profiles` and joins the
evidence metadata row by `storage_path` through `mg_can_access_site()` before
granting access — role-blind reads (prior audit defect 0.3) are structurally
impossible.

**Signed-URL mint gate [IMPLEMENTED 2026-09-26 — migration 0006].** URLs are
no longer minted from a bare metadata read: `evidence.getUrl` calls the
`evidence_url(p_evidence_id, p_ttl_seconds)` SECURITY DEFINER RPC, which
re-derives the caller's CURRENT access (same `mg_can_access_site` predicate
as the storage read policy) at every mint, refuses role-less accounts, clamps
TTL server-side to 30–300s, and appends a row to the definer-only
`evidence_url_audit` log (actor, evidence, TTL; no URL material stored).
TTL drops from 3600s to 120s. Revocation is permission-bound: losing site
access refuses the next mint immediately; a leaked link is at most a 2-minute
exposure (was one hour). Residual, documented honestly: an in-flight ≤120s
URL stays valid until expiry after a permission change — closing even that
requires a fetch-time proxy (edge infrastructure deliberately not added).
Verified by `tests/evidence-url.test.ts` and live (docs/11).

## Known gaps [PLANNED / REQUIRES GOVERNMENT CONFIRMATION]

0. **Privileged-RPC execute surface is intent, not guarantee, on old lineages.**
   Repository migrations (0002, ADR-11) explicitly revoke `EXECUTE` from
   `PUBLIC`/`anon` on admin RPCs. The live project was provisioned before that
   revoke existed: anon can *invoke* privileged RPCs there and is stopped by
   the definer bodies' internal admin checks (verified: `FORBIDDEN`, not
   success). Every RPC must keep its internal authorization check; a
   future RPC that relies on the privilege layer alone would be anon-callable
   on lineages provisioned before 2026-09-25. New deployments from the
   repository migrations get both layers.
   **Repo half closed 2026-10-05 (migration 0011):** a probe-verified audit
   found the repository surface far wider than this entry assumed — anon held
   all 37 non-extension functions (0002's blanket grant), and the built-in
   PUBLIC `=X` grant on post-0002 functions DEFEATED 0009's and 0010's
   per-function `revoke … from anon` (anon could still execute
   `triage_community_report` and `mg_resolve_organization` through PUBLIC;
   `ALTER DEFAULT PRIVILEGES` cannot remove the PUBLIC default for new
   functions on this PostgreSQL). 0011 resets the surface deny-by-default —
   anon executes exactly the two public flows, authenticated executes the
   seven documented RPCs + authorization helpers, extensions excluded — and
   `tests/migration-apply.test.ts` (GAP-0) pins the exact allowlists, forbids
   PUBLIC grants, and requires every client-reachable SECURITY DEFINER
   function to self-authorize or be a reviewed helper. The live lineage
   still runs 0001–0008: until the owner pushes 0009–0011, this entry's
   original wording (internal checks as the only backstop) remains accurate
   THERE.
1. Rate limiting on the public report endpoint. Since migration 0005 the
   `submit_community_report` security-definer RPC enforces a 30-reports-per-
   minute rolling bucket **per client source**: the source is derived
   server-side from the PostgREST-injected `request.headers` GUC (first
   `x-forwarded-for` hop, `x-real-ip` fallback — never a client-supplied
   argument), and the bucket key stores only a salted SHA-256 digest of the
   address, so the limiter table cannot become a surveillance log. Sourceless
   calls degrade to one shared global bucket (fail-closed). Honest limits:
   header-derived identity is only as trustworthy as the platform edge that
   sets the chain — hosted Supabase normalizes it, but on a self-hosted or
   misrouted deployment a client that bypasses the proxy could present a
   fresh spoofed hop per request; an edge-function limiter would be strictly
   stronger and remains future work. Verified by tests/rate-limit.test.ts
   (source isolation, cap boundary, window reset, degraded mode, digest-only
   persistence). NOTE: converged on the live deployment 2026-09-26 (same
   day), where a partial earlier paste had left public reporting down — the
   live table now carries `window_start`, the function resolves `digest()`
   via the `extensions` schema, and the legacy enum-typed overload +
   `updated_at`/`rate_bucket` columns are retained inert residue (docs/11).
2. ~~Account recovery and MFA beyond password sign-in~~ **Closed 2026-09-27
   (Gap #4, repo):** password recovery (request + set) and TOTP multi-factor
   authentication are implemented end-to-end — client helpers over the
   GoTrue API (`src/lib/supabase.ts`: `mfaAal`, `mfaListFactors`,
   `mfaEnrollStart`, `mfaEnrollVerify`, `mfaUnenroll`; `src/lib/backend.ts`:
   `resetPasswordEmail`, `updatePassword`, `signInEmailMfaAware`), a sign-in
   challenge step and forgot-password/reset panels on `/auth`, an Account
   Security page at `/portal/security` (enroll with authenticator-secret
   entry, verify, unenroll, password change), and a recovery deep link that
   restores a session before the router claims it (`detectSessionInUrl` is
   ON). Enforced contract: once a verified factor exists, the account
   requires aal2 — a fresh password session gets `MFA_CHALLENGE_REQUIRED`
   and the UI completes sign-in only after the code verifies. Verified by
   `tests/account-security.test.ts` (12 tests; the bridge's GoTrue fake
   verifies REAL RFC 6238 TOTP codes, so the "wrong code rejected / right
   code accepted" assertions are genuine cryptography, not scripted
   echoes). **Honest residuals:** (a) TOTP only — recovery CODES, WebAuthn
   and phone factors are NOT implemented; a lost authenticator is an
   administrative recovery through the program office (stated on the
   Security page), not a self-service loop; (b) the live Supabase project
   must have MFA enabled in its Auth settings before this works on live —
   configuration, not code, and NOT yet confirmed (needs owner access);
   (c) recovery emails require SMTP configured on the project — the client
   contract is proven, delivery is platform configuration; (d) enrollment/
   verification are GoTrue-side operations and are NOT written to
   `audit_log` — if the audit trail must record MFA changes, that requires
   an auth hook (PROPOSED, requires owner confirmation).
3. Encryption at rest is inherited from the Supabase platform; field-level
   encryption for sensitive attachments is planned.
4. Role assignment currently requires the target user to have signed in once
   (`provision_user_by_email` matches on the profiles row); a full
   account-lifecycle workflow (invite emails, admin-created accounts) requires
   organizational confirmation.
5. County/operator LIST scoping is enforced by RLS per document, not merely the
   data layer: every site-scoped record carries a denormalized `county` +
   `operator_name` stamped by triggers at write time (and refreshed by
   `sites_rescope` when a site's county/operator changes), and every scoped
   read policy evaluates `mg_can_access_site(site_id)`. A residual caveat:
   rows written directly via SQL before this schema existed would need a
   backfill; rows written through the API are always stamped.
6. ~~A leaked 1h signed URL remains valid until expiry~~ **Closed 2026-09-26
   (migration 0006):** URLs are minted through the `evidence_url` gate with a
   120s TTL and a current-permission re-check per mint (see "File access"
   above). Residual: an in-flight ≤120s URL outlives a permission change by
   at most two minutes; a fetch-time proxy would close even that and remains
   PROPOSED, REQUIRES OWNER/GOVERNMENT CONFIRMATION (new infrastructure).

## Frontend security notes

- `returnTo` redirect validation blocks open redirects
  (`resolveRedirectAfterAuth` requires a single leading slash); the
  recovery `redirectTo` lands on the app root — no user-controllable
  redirect target is ever sent to GoTrue.
- No dangerouslySetInnerHTML usage; Leaflet marker HTML is static, sanitized
  constants.
