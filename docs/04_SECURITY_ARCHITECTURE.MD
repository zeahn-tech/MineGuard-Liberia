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

1. Rate limiting on the public report endpoint. A per-minute counter is now
   enforced server-side by the `/rateLimits` rules (the report's `rateBucket`
   must equal the current server minute; the counter increments by exactly one
   and is capped at 30/min), and the submission flow performs the matching
   client handshake. Honest limits: the bucket is keyed on server time while
   the client keys on device time (a minute-boundary straddle can be rejected),
   and the cap is global per minute, so a flood can still exhaust it. A robust
   per-source limiter (Cloud Function + App Check) remains planned and needs
   the Blaze plan.
2. Account recovery and MFA beyond password sign-in.
3. Encryption at rest is inherited from the Firebase platform; field-level
   encryption for sensitive attachments is planned.
4. Role assignment currently requires the target user to have signed in once
   (provisioning by email); a full account-lifecycle workflow requires
   organizational confirmation.
5. County/operator LIST scoping is now enforced by the RULES, not merely the
   data layer: every site-scoped record (sites, inspections, findings,
   correctiveActions, incidents, environmentalObservations) carries a
   denormalized `county` + `operatorName` stamped at write time, the `list`
   rules check them per document via `siteVisible()`, and the data layer
   constrains its queries with the same value (`scopeConstraintForUser` in
   `src/lib/types.ts`) — a mismatch is rejected by Firestore, not silently
   filtered. Two honest caveats remain: (a) records written outside the data
   layer (console/CI/external tooling) miss the stamp and are therefore
   invisible to county/operator callers until an admin backfill stamps them
   (admin/national reads are unaffected); (b) evidence is the one exception —
   its metadata is append-only, so its list rule joins `parentType`+`parentId`
   to the parent record instead of using a denormalized field.

## Frontend security notes

- `returnTo` redirect validation blocks open redirects
  (`resolveRedirectAfterAuth` requires a single leading slash).
- No dangerouslySetInnerHTML usage; Leaflet marker HTML is static, sanitized
  constants.
