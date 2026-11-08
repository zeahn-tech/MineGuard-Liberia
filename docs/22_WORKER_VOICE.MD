# 22 — Worker Voice: named, confidential and anonymous safety reporting

Implementation Phase 4. Migrations `0046_worker_voice.sql` and `0047_worker_voice_decisions.sql` (the owner's five decisions). Neither is applied to production by this change; apply 0046 then 0047.

## What it is

A way for workers to raise safety concerns (unsafe conditions, near misses, equipment or maintenance
hazards, unsafe procedures, repeated concerns, unresolved corrective actions, other) in one of three
modes, with the privacy of each described honestly **before** anything sensitive is typed.

| | Named | Confidential | Anonymous |
|---|---|---|---|
| Needs sign-in to send | yes | yes | **no** (site code instead) |
| Identity held | yes | yes, in a separate closed table | **none exists** |
| Who sees the identity | the report's company reviewers, and Ministry staff for the area | **Ministry staff for the area only** (administrators, supervisors, inspectors), with a stated purpose; recorded; count shown to the reporter. **Not** the company's own administrators, managers or safety officers | nobody (nothing to see) |
| Report content seen by | reviewers | reviewers | reviewers |
| Follow-up | code, or "my reports" | code, or "my reports" | code only |

Company reviewers = the company administrator, and the site manager / safety officers **assigned to that
site** (not for a report routed to administrators only). They triage, assign, message, escalate, promote to
an incident and close.

**Ministry staff** (administrators, supervisors, inspectors; permission `wv.identity`, limited to their
jurisdiction by the existing scope rules) can **read** reports, messages and photos for sites in their area
and **open sender identities** (named; confidential with a purpose). They are not notified, cannot act on a
report, and cannot see the company's internal reviewer history. This reverses the first version of this
feature, which gave the Ministry no access; the reporter-facing wording says so before anything is typed.
No other regulator is involved and nothing says otherwise.

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

## The five owner decisions (migration 0047)

1. **Confidential identity: Ministry staff only.** `mg_wv_identity`: confidential → in-scope Ministry staff
   with a purpose of at least 10 characters; the company's administrators, managers and safety officers are
   refused ("only Ministry staff"). Named → company reviewers or in-scope Ministry staff. Anonymous → nothing
   exists. A person cannot open their own report. Read access for Ministry staff is what lets them find the
   report; they have a read-only page at `/portal/voice`.
2. **Photos (JPEG only, up to 3, under 1 MB each).** The phone re-draws and shrinks the picture (dropping
   camera, time and location data) and then structurally rewrites the JPEG keeping only picture segments. The
   server **refuses** the report unless every file passes `mg_wv_jpeg_problem`: only a bare JFIF header (no
   thumbnail) plus quantization/Huffman/frame/scan segments, at most 4096 px a side, valid start and end, no
   APPn/COM marker anywhere (including hidden after the scan). Files live in a closed table (no URL exists),
   are shown to reviewers and in-scope Ministry staff only, as an image, are immutable, and carry a
   server-computed SHA-256. **Not done:** malware scanning; protection against what the picture shows (faces,
   name tags, equipment); video and PNG. Reviewers are told photos are not scanned; reporters are told what
   is and is not removed.
3. **Site-code controls.** 90-day expiry (a member's next request after expiry issues a new code, and the
   old poster stops working); a pause switch for anonymous intake that tells people honestly; per-day intake
   counts (not tied to any report) with an "unusual volume" signal (20 or more in a day and over four times
   the usual).
4. **Two-way messaging and push.** The reporter can reply with the follow-up code alone (or from "my reports"
   if named/confidential); reviewers' messages and the reporter's replies form a thread. Replies are limited
   (1,000 characters, 10 a day per report, per-source limits, wrong-code guesses limited), blocked once the
   report is closed, carry an hourly time and no actor, and raise the same generic notification. **Push:**
   reviewers with a live subscription get a queued push with the fixed payload `{"v":1,"t":"wv"}` (no id, no
   text); the service worker shows only the generic notice; the `worker-voice-push` function is called by a
   scheduler holding a shared secret (`supabase/cron/worker-voice-push-sweep.sql`, **not applied by
   migrations**). Without the scheduler, in-app notifications still work and push does not.
5. **Small sites** (fewer than 10 people assigned; `mg_wv_small_site_threshold()`): the reporter is warned
   before sending, the received and occurrence times of confidential/anonymous reports are coarsened to the
   **day**, and reviewers see a "small site" flag and a reminder not to try to work out who wrote it. This
   reduces timing correlation; it cannot make a small crew anonymous, and the app says so.

### Additional deployment steps for 0047
* Apply `0047` after `0046`.
* Deploy the edge function: `supabase functions deploy worker-voice-push --no-verify-jwt --use-api`; set
  `WORKER_VOICE_PUSH_SECRET`; reuse the existing `VAPID_*` secrets; then (optionally) schedule the sweep.
* Ministry staff need nothing: the `wv.identity` permission is granted to admin, supervisor and inspector.
* Photos travel inside the submit request (base64, up to about 3.2 MB). If your gateway limits request size
  below that, anonymous reports with three large photos will fail with a clear message.

### Additional rollback for 0047
Hide: remove the `/portal/voice` route and nav entry. Remove data: drop `worker_voice_messages`,
`worker_voice_attachments`, `worker_voice_code_usage`, `worker_voice_push_outbox`; drop the columns
`small_site` (reports) and `anonymous_enabled`, `expires_at` (site codes); delete the `wv.identity`
permission rows; drop the `mg_wv_*` functions added in 0047 and re-run 0046 to restore its versions.

## Remaining risks and unresolved decisions

1. **Ministry staff can now read every report in their area**, including anonymous and
   confidential content and photos. That is required for them to open an identity, and it is a larger
   audience than the company alone. Anyone who objects can narrow it (for example: read only reports for
   which an identity request has been filed) by changing `mg_wv_ministry_can_read`.
2. **A confidential identity is no longer reachable by the company at all.** If the company must act on a
   retaliation concern, it has to go through the Ministry.
3. **Photos are not virus-scanned**, and their content can identify people.
4. **Anyone who sees the posted site code can send an anonymous report.** Expiry, pausing and the volume
   signal reduce the harm; they do not remove it.
5. **Small sites weaken anonymity** whatever the app does.
6. **Push is best effort** and needs the scheduler; it can be delayed or blocked by the device.
7. **Reviewer availability.** If every administrator is the reporter or conflicted, nobody can review.
8. **No independent certification** of the anonymity design.
9. English only. Rate buckets (`wv:*`) are pruned opportunistically.
