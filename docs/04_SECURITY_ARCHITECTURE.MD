# 04 — Security Architecture

**Status:** implemented controls below; gaps listed honestly.

## Principles applied [IMPLEMENTED]

- **Least privilege.** Four roles; access helpers in both the security rules and
  the data layer (`requireStaffUser`, `requireReviewerUser`, `requireAdminUser`,
  operator isolation).
- **Defense in depth.** Route guard (RequireAuth) + Firestore/Storage security
  rules (authoritative server boundary) + identical checks re-derived in
  `src/lib/backend.ts` before every operation + scope filtering inside queries
  + audit logging.
- **Server-side authorization.** `firestore.rules` derives every permission from
  `/users/{uid}` (admin-writable only). The client never grants access; hiding
  UI is cosmetic only.
- **Geographic access control.** County-scoped staff can only read/write records
  in their county (`siteVisible()` / `siteVisibleAt()` in the rules; mirrored in
  the data layer).
- **Tenant isolation.** Operators match sites by exact `operatorName`; they can
  only acknowledge findings and respond to corrective actions on their own
  sites, enforced by rules and data layer alike.
- **Secure sessions.** Firebase Authentication (email/password + anonymous
  guest); session tokens managed by the platform.
- **Audit logging.** Append-only `auditLog` written by the data layer inside
  every consequential mutation; rules permit create-only (no update, no delete).
- **Input validation.** TypeScript-typed function arguments in the data layer;
  rule-level guards on public writes (report description length, status
  literals, evidence size); closed enums for statuses, severities, categories,
  verification states.
- **No secrets in client code.** Firebase web config is public by design;
  authorization never depends on its secrecy. No service credentials in the
  frontend; any future server keys go through Cloud Functions with env-based
  secret management.

## File access [PARTIAL]

Evidence bytes live in Cloud Storage under `evidence/{uid}/`; storage rules
require sign-in for read and restrict writes to the owning user's namespace
(25MB cap). Per-record ACL enforcement at the download-URL layer is [PLANNED] —
`evidence.getUrl` requires authentication and the metadata list is staff-only,
but a leaked download URL remains valid until expiry.

## Known gaps [PLANNED / REQUIRES GOVERNMENT CONFIRMATION]

1. Rate limiting on the public report endpoint (basic size/count guards exist;
   dedicated limiter planned).
2. Account recovery and MFA beyond password sign-in.
3. Encryption at rest is inherited from the Firebase platform; field-level
   encryption for sensitive attachments is planned.
4. Role assignment currently requires the target user to have signed in once
   (provisioning by email); a full account-lifecycle workflow requires
   organizational confirmation.
5. Rules cannot fully express county-scoped list queries (rules authorize
   get/list coarsely for staff; county filtering is enforced in the data layer
   and re-checked by siteVisible() on single-document gets). A hardened
   variant should split county-scoped users into per-county collections or use
   Cloud Functions for privileged reads.

## Frontend security notes

- `returnTo` redirect validation blocks open redirects
  (`resolveRedirectAfterAuth` requires a single leading slash).
- No dangerouslySetInnerHTML usage; Leaflet marker HTML is static, sanitized
  constants.
