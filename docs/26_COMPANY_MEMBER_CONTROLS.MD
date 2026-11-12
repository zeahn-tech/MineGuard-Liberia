# Company member controls — suspend, remove, block (migration 0054)

Screen: **Operate → Team** (company administrators only).

| Action | Effect | Reversible | Reason |
|---|---|---|---|
| **Suspend** | Access stops at once. Membership and site assignments are kept. | Yes — *Reinstate* | Required (5–500 chars) |
| **Remove** | Membership ends, site assignments are revoked, access stops. Works on active and suspended members. They can be invited again. | By re-inviting | Optional |
| **Remove and block** | Remove, plus a standing block: cannot request to join, be invited, accept an old invitation, be imported or be reinstated. Pending invitations to them are cancelled. | *Unblock* lifts the barrier only; access is **not** restored — they must be invited or approved again. | Required |

## Rules (enforced in the database, mirrored in the UI)
- Authorized by `mg_can_manage_company(org)`: an active administrator of the **same approved** company, or the Ministry. No cross-company reach.
- Never against yourself; never against a company administrator unless the Ministry.
- The reason is visible to company administrators only and is written to the audit trail (`mg_audit_row`). The affected person is notified **that** their access changed, never **why**.
- The block is enforced by triggers on `organization_members` and `organization_invitations`, so every existing and future path is covered. The bulk-import check reports a blocked address as an error row.
- Suspension clears `profiles.role`, `organization_id` **and** `operator_name` (the `profiles_org` trigger would otherwise re-derive the binding from the name). Reinstatement re-binds explicitly and refuses if the person has since joined another company.

## Screen additions
Search by name/email, filter by role and status, per-row actions menu, suspension note (when/by whom/why), *Blocked people* list with *Unblock*.

## Deployment
Apply `0054_company_member_discipline.sql` **before** the frontend. Until then the screen falls back to the old list (no suspended members, no block list).

## Known limits
- A suspension has no automatic end date; an administrator must reinstate.
- Account deletion (0039) revokes only pending/active memberships; a suspended membership of a deleted account is cleaned up by its existing delete step.
