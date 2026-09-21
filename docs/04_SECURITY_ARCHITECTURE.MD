# 04 — Security Architecture

**Status:** implemented controls below; gaps listed honestly.

## Principles applied [IMPLEMENTED]

- **Least privilege.** Four roles; narrow server-side helpers
  (`requireStaff`, `requireReviewer`, `requireAdmin`, operator isolation).
- **Defense in depth.** Route guard (RequireAuth) + server-side authorization on
  every function + scope filtering inside queries + audit logging.
- **Server-side authorization.** All permission logic in
  `src/convex/lib/authz.ts`. The client never grants access; hiding UI is
  cosmetic only.
- **Geographic access control.** County-scoped staff can only read/write records
  in their county (`canAccessSite`, per-module filters).
- **Tenant isolation.** Operators match sites by exact `operatorName`; they can
  only respond (acknowledge findings, respond to corrective actions) on their own
  sites, enforced server-side.
- **Secure sessions.** Convex Auth manages tokens; email OTP for sign-in;
  anonymous guest accounts supported for evaluation only.
- **Audit logging.** Append-only `auditLog` written inside mutations; includes
  actor identity, action, entity, human-readable summary.
- **Input validation.** Convex argument validators on every public function;
  closed enum unions for statuses, severities, categories, verification states.
- **No secrets in client code.** No service credentials in the frontend; auth
  provider configuration lives server-side.

## File access [PARTIAL]

Evidence files live in Convex storage; metadata writes and URL retrieval are
authenticated functions. Per-record ACL enforcement at the storage URL layer is
[PLANNED] — currently the URL action requires authentication but does not
re-check per-site access for the file itself.

## Known gaps [PLANNED / REQUIRES GOVERNMENT CONFIRMATION]

1. Rate limiting on the public report endpoint (basic size/count guards exist;
   dedicated limiter planned).
2. Account recovery and MFA beyond email OTP.
3. Encryption at rest is inherited from the Convex platform; field-level
   encryption for sensitive attachments is planned.
4. Role assignment currently requires the target user to have signed in once
   (provisioning by email); a full account-lifecycle workflow requires
   organizational confirmation.

## Frontend security notes

- `returnTo` redirect validation blocks open redirects
  (`resolveRedirectAfterAuth` requires a single leading slash).
- No dangerouslySetInnerHTML usage; Leaflet marker HTML is static, sanitized
  constants.
