# 15 — Data Governance

**Status:** principles and implemented controls; formal policy instruments
require the adopting institution. [REQUIRES GOVERNMENT CONFIRMATION]

## Ownership & provenance

- Every domain record stores creator identity and creation time, stamped
  server-side. Review decisions store reviewer identity and time.
- Environmental claims carry an explicit verification state; community reports
  remain allegations until a named reviewer verifies them.
- The audit log records actor, action, entity, and a human-readable summary for
  every consequential write.

## Corrections vs deletion

- Domain records use lifecycle states; no hard-delete endpoints exist.
- Corrections happen as new recorded states (status transitions, review notes),
  preserving the trail. Site records can be suspended/closed but not erased.

## Minimization

- Public tracking endpoint exposes only tracking code, status, and date.
- Public statistics expose only aggregate counts.
- Community report contact phone is optional and shown only to staff in triage.

## Access governance

- Roles and scopes are assigned by admins and audit logged.
- Operators are isolated to their own organization's sites.
- Staff listing endpoints filter by scope inside the query.

## Retention & legal hold [PROPOSED]

Retention schedules for evidence, community reports, and audit history depend on
the adopting institution's records law and policy. The schema preserves what is
needed for retention decisions (timestamps, actorship) but no schedules are
implemented or assumed.

## Sensitive data handling

- GPS coordinates are operational data, shown only within authorized scopes.
- No special-category personal data is collected by design (no national ID, no
  biometrics). Future intake forms must re-verify this rule.
- Evidence files may contain sensitive imagery; ACL deepening is tracked in
  docs 04 and 07 before pilot.

## Data quality duties

- Inspectors choose verification states honestly; supervisors verify.
- Risk indicator weights and outputs are reviewable (explainable breakdowns) and
  never presented as determinations of guilt.
