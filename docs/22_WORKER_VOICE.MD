# 22 — Worker Voice: named, confidential and anonymous safety reporting

Implementation Phase 4. Migration `0046_worker_voice.sql`. Not applied to production by this change.

## What it is

A way for workers to raise safety concerns (unsafe conditions, near misses, equipment or maintenance
hazards, unsafe procedures, repeated concerns, unresolved corrective actions, other) in one of three
modes, with the privacy of each described honestly **before** anything sensitive is typed.

| | Named | Confidential | Anonymous |
|---|---|---|---|
| Needs sign-in to send | yes | yes | **no** (site code instead) |
| Identity held | yes | yes, in a separate closed table | **none exists** |
| Who sees the identity | the report's reviewers | **company administrator only**, with a stated purpose, recorded, count shown to the reporter | nobody (nothing to see) |
| Report content seen by | reviewers | reviewers | reviewers |
| Follow-up | code, or "my reports" | code, or "my reports" | code only |

Reviewers = the company administrator, and the site manager / safety officers **assigned to that
site** (not for a report routed to administrators only). The **Ministry has no access** and nothing in
the app says it does.

## Reuse, and why not `incidents`

Reused: organizations/members/site assignments and `mg_can_prepare_jsa` / `mg_jsa_sites` (who may
report where); the `notifications` table and bell; `rate_limits` + `mg_client_ip` (the 0005 digest
pattern); the offline store (`storeGet/storeSet`, durable-or-throw); PageLoading/EmptyState; the
operator shell; account deletion (0035); and the **existing incident workflow** for investigation and
corrective actions.

Not reused for storage: `incidents.reported_by_id` is NOT NULL and "incidents read" shows every row to
everyone who can see the site, Ministry included. An anonymous or confidential report stored there would
need a fake reporter or would expose the real one. So Worker Voice is a narrow intake and triage store
(four tables). A reviewer promotes a report to a normal incident with `mg_wv_create_incident`: the
reviewer writes the incident text (the report text is not copied), the reviewer is the incident's
reporter, and a one-way link records it. Incident investigation, corrective actions and closure then
happen where they already happen. It is not a second incident-management system.

## Data architecture

* `worker_voice_reports` — content only. **No identity column of any kind** (no user, email, employee
  number, member id, `updated_by`, IP, device). Asserted by a test that lists the columns.
* `worker_voice_identity` — named + confidential only. Closed: no grant, no policy. Reachable only via
  `mg_wv_identity` (named → report's reviewers; confidential → company administrator + purpose ≥ 10
  characters). Cascade-deleted with the profile and erased when an account is deleted/anonymized (0035).
  **An anonymous report has no row here.**
* `worker_voice_events` — reviewer-side history. The `submitted` event never records an actor. Identity
  openings are recorded (actor + purpose); the reporter sees only how many times.
* `worker_voice_site_codes` — one rotatable 10-character code per site. It routes anonymous reports
  without a public list of sites. It is not a secret of the same kind as the follow-up code: it is posted
  at the site. Wrong guesses are rate-limited per source.
* The generic audit trigger is deliberately **not** attached to these tables (it records the actor).
  A test proves `audit_log` has no `worker_voice*` rows.
* `mg_wv_submit_anonymous` never reads `auth.uid()` (a test checks the source and sends it with a session
  present). The app calls it from a client with no session at all.
* Confidential/anonymous received time is rounded **down to the hour**.
* Follow-up code: 96 random bits generated on the device; the server stores `sha256('wv1:' || code)` only.
  Public status returns a coarse stage and a reviewer-written update, nothing else. Wrong, malformed and
  truncated codes are indistinguishable. Lookups and wrong guesses are rate-limited per source.
* Rate limiting stores a salted SHA-256 of the connecting address (as 0005), never the address, and the
  bucket is never linked to a report.
* Notifications to reviewers are generic: "MineGuard: A safety report requires review. Sign in with your
  authorized account to access it." No reporter, content, mode, category or site. In-app only in this
  phase; **no push** was added.

## Abuse prevention (without defeating anonymity)

Server-side validation of every field; 4,000-character description limit; ten anonymous reports per source
per hour and sixty per site per hour (ten per signed-in person per hour); ten wrong site codes or wrong
follow-up codes per source per hour; no raw address kept; no CAPTCHA and no third-party service (none was
introduced, so there is no third-party privacy implication). Identical reports within 14 days are
**accepted** and flagged "similar report received earlier" for reviewers. Serious reports are never
rejected for being anonymous. Replays are harmless: the same code answers `duplicate`.

## Limits of anonymity (shown to users, and true)

* **Not certified.** Nobody has independently verified this design.
* What you write can identify you, especially on a small site or crew. Site choice narrows the group.
* Hosting, the database platform, your mobile network and any proxy may log connection metadata (address,
  timing) outside MineGuard's report records. We have **not** verified that none is kept, and do not claim
  it. For named/confidential reports the platform's request logs can show your account called the endpoint.
* A signed-in person who sends anonymously is still on a device that may be observed. The anonymous call
  carries no session, but the site-code fetch (members only) is an ordinary signed-in call.
* Pending reports are stored on the phone until sent or deleted. Reviewers are told not to try to work out
  who an anonymous reporter is; the app cannot enforce that.
* Retaliation: MineGuard cannot guarantee protection from it. The app says so.

## Attachments: deliberately not in this phase

No files or images are accepted in any mode. Safe anonymous uploads need a pipeline this repository does
not have: server-side type and size validation, metadata (EXIF, device, location) stripping, malware
scanning, a private bucket with signed short-lived URLs, and a rule for evidence integrity. An
unauthenticated upload without those would weaken anonymity and security. The smallest safe design is
named in "Decisions" below. A test asserts the schema accepts no file fields.

## Escalation and the "report is about the reviewer" route

Reporters can mark a concern as being about the people who would normally review it: it then goes to
company administrators only. A site manager / safety officer can escalate to administrators (reason
required). Administrators have **no higher route in MineGuard** and are told so; the app points to
company procedures and legal channels. No regulator channel is implied.

## Deployment

1. Apply `0046_worker_voice.sql` (after 0044/0045). Run it yourself; nothing here applies it.
2. No secrets, no new service, no environment variables, no Edge Function.
3. Deploy the app. Public routes: `/voice`, `/voice/status`. Member routes: `/operate/voice`,
   `/operate/voice-review`.
4. A company administrator opens **Voice review → Site codes**, shows each site's code and posts it at
   the site. Rotate it if misused.
5. Decide who the reviewers are (assign site managers / safety officers to sites).
6. Confirm the policy decisions below before announcing the feature.

## Manual verification

1. Signed out, open `/voice`, enter a valid site code, send. Note the code. Open `/voice/status`, enter it:
   stage "Received", no other detail.
2. In the review queue (administrator): the report shows **Anonymous**, hourly time, no identity action.
3. Post an update for the reporter; re-check the status page: the update appears, nothing else.
4. Signed in as a worker, send a **Confidential** report. As a site manager, confirm the identity cannot be
   opened. As a company administrator, open it: a purpose is required; as the worker, "My reports" shows
   it was opened once.
5. Tick "This concerns the person who would normally review it": the site manager no longer sees it.
6. Turn the phone offline, send: the screen says "Saved on this device. Not yet received." and the code is
   shown. Go online: it sends and disappears from "Waiting on this device".
7. Check the bell: the notification text is generic.
8. In the database: `select count(*) from audit_log where entity_type like 'worker_voice%';` is 0 and
   `worker_voice_reports` has no identifying columns.
9. Browser dev tools, Network tab, while sending anonymously: the request carries the public key only.

## Rollback

Hide the feature: remove the four `voice` routes in `src/main.tsx`, the two nav entries and the landing
link (the data stays). Remove the data: `drop table worker_voice_events, worker_voice_identity,
worker_voice_reports, worker_voice_site_codes;` then drop the `mg_wv_*` functions and the
`wv_forget_reporter` trigger on `profiles`, and restore `notifications_kind_check` from 0037 (delete any
`kind = 'worker_voice'` notifications first). Reports are never deleted by the app, so export first if
they must be kept.

## Decisions and remaining risks

1. **Who may open a confidential identity.** Implemented: company administrators, purpose required,
   recorded. If the policy is different (a named ombuds role, or two-person approval), change
   `mg_wv_identity`. Note a company administrator can be the subject of a report; there is then no
   in-app alternative.
2. **Site code distribution.** Anyone who sees the poster can send an anonymous report. That is the
   trade-off for needing no account; rotate on abuse.
3. **Small sites weaken anonymity**; the app says so but cannot fix it.
4. **Attachments** (see above). Smallest safe design: a separate private bucket, a server-side
   ingestion function that re-encodes images (dropping metadata), type/size allow-list, scanning, short
   signed URLs only for reviewers, and no evidence for anonymous reports until that exists.
5. **No two-way anonymous messaging.** Reviewers can write one update; the reporter cannot reply.
6. **No push notification** for Worker Voice (in-app only). A push would need the same generic text.
7. **Reviewer availability.** If every administrator is the reporter or conflicted, nobody can review.
8. **Rate buckets** (`wv:*`) are pruned opportunistically on anonymous submissions; add scheduled cleanup
   if traffic is low.
9. English only.
