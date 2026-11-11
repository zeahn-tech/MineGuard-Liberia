# 23 — Worker Voice to the Ministry: confidential reporting to government

Migration `0050_ministry_voice.sql`. Builds on `22_WORKER_VOICE.MD` (migration 0046). Not applied to
production by this change.

## What it is

Workers can flag **bad labour practices, unsafe work practices and bad work habits** carried out by a
company **directly to the Ministry**, confidentially or anonymously, so that government can make informed
decisions and press companies to do the right thing.

It is a **second, separate channel** beside the existing company one. The reporter picks the audience on
the same Worker Voice form ("Who should receive this?"), then the privacy mode.

| | Company channel (0046) | Ministry channel (0050) |
|---|---|---|
| Tables | `worker_voice_*` | `ministry_voice_*` |
| Reviewers | the **company's administrators**; site manager / safety officers assigned to the site | **Ministry administrators** and **national-scope Ministry supervisors** |
| Opens a confidential identity | company administrator, with a purpose, recorded | **Ministry administrator**, with a purpose, recorded |
| Review page | `/operate/voice-review` (company workspace) | `/portal/voice-ministry` (staff portal, "Worker Reports") |
| Can the company see it? | yes, it is the company's own channel | **never** |
| Can the Ministry see it? | **no** (unchanged) | yes |
| Follow-up code | `WV-…` | `MV-…` |
| Categories | safety concerns (unsafe condition, near miss, …) | labour practices, unsafe work practices, work habits (12) |

### The company channel is unchanged

The company administrators remain the reviewers of Worker Voice and Voice review, exactly as before, and
the Ministry has no access to the company channel. `0046` was **not edited**. Nothing in `0050` adds a
Ministry grant to a `worker_voice_*` table or RPC, and a test asserts that Ministry accounts read zero
company-channel rows and are refused every company-channel reviewer function.

## Why separate tables, not a `channel` column

A report *about* a company must never be readable by that company, and a company administrator may be the
subject of the report. One shared table behind one policy would make that a single predicate away from a
leak. Separate tables, separate reviewer functions, a different code-hash prefix (`mv1:` vs `wv1:`),
different rate-limit buckets (`mv:*`) and a different notification link make the separation structural.
Company accounts hold no grant, no policy and no RPC on `ministry_voice_*`; a test runs every reviewer
function as every kind of company account and expects `FORBIDDEN`.

## Data architecture (same properties as 0046)

* `ministry_voice_reports` — content only. **No identity column of any kind**; no file fields.
* `ministry_voice_identity` — named + confidential only. Closed: no grant, no policy. Reachable only via
  `mg_mv_identity`. Erased when an account is deleted (trigger `mv_forget_reporter`, plus cascade).
  **An anonymous report has no row here.**
* `ministry_voice_events` — reviewer-side history. `submitted` never records an actor. Identity openings
  are recorded (actor + purpose); the reporter sees only how many times.
* No audit trigger on these tables (it would record the actor); a test proves `audit_log` has no
  `ministry_voice*` rows.
* `mg_mv_submit_anonymous` never reads `auth.uid()`; the app calls it from a client with no session.
* Confidential/anonymous received time is rounded **down to the hour**.
* Follow-up code: 96 random bits generated on the device; the server stores `sha256('mv1:' || code)` only.
  The public status shows a coarse stage and a reviewer-written update, nothing else. A company-channel
  code never opens a Ministry report, and vice versa.
* Anonymous reports are routed with the **site's posted code** (`worker_voice_site_codes`, 0046), so there
  is no public list of sites. The report therefore **does name the company and site** — a report about a
  company is only useful to the Ministry if it says which one. The form says so.
* Notifications to Ministry reviewers are generic ("A worker report requires review…"): no company, site,
  reporter, content, mode or category. Company people are never notified. In-app only; no push.

## Who can send

* Named / confidential: a signed-in company member allowed at the site (`mg_can_prepare_jsa`, as 0046).
  Ten per person per hour.
* Anonymous: anyone with the site code, no account. Ten per source per hour, sixty per site per hour, ten
  wrong site codes or wrong follow-up codes per source per hour. Serious reports are never rejected for
  being anonymous. Identical reports within 14 days are accepted and flagged "similar report received earlier".

## What the Ministry sees

`/portal/voice-ministry` (nav: **Worker Reports**, for administrators and supervisors; the database decides):

* **Overview** — totals, open, open high/critical, counts by group (labour / safety / conduct / other) and
  by company. Counts only: no text, no identity. These are allegations until reviewed, not findings; the page says so.
* **Queue** — each report with company, site, category, urgency, status, similar-report flag. Triage
  (severity, assignee among Ministry reviewers), status (`received → triage → investigating →
  action_taken → closed`, no moving backwards, a reason is required to close), a reporter-facing update, and
  — separately, recorded — opening the reporter's identity.
* A reviewer cannot review a report they sent; confidential identities need a **Ministry administrator**
  and a stated purpose; a supervisor can see a *named* reporter but not a confidential one.

## Limits (shown to users, and true)

Same as `22_WORKER_VOICE.MD`: not certified; what you write can identify you, especially on a small site or
crew (and here the company is named); hosting/network logs sit outside MineGuard's report records;
MineGuard cannot guarantee protection from retaliation. Additionally:

* A Ministry report **does not start an investigation by itself**, and the Ministry may not be able to tell the
  reporter what it decides. The form says so; no outcome is promised.
* This is **not an emergency channel**. Critical urgency shows the site-emergency-procedure warning.
* Reviewers are told not to share content with the company in a way that could identify the reporter; the app
  cannot enforce it.
* No attachments (same reasons as 0046).

## Deployment

1. Apply `0050_ministry_voice.sql` after `0046_worker_voice.sql` (it reuses its site codes and rate-limit helper)
   and after `0049`. Run it yourself; nothing here applies it.
2. No secrets, no new service, no environment variables, no Edge Function.
3. Deploy the app. Public: `/voice`, `/voice/status` (now also takes `MV-` codes). Members: `/operate/voice`.
   Ministry staff: `/portal/voice-ministry`.
4. Decide which Ministry staff are administrators / national supervisors; they are the reviewers.
5. Confirm the policy decisions below before announcing the feature.

## Manual verification

1. Signed in as a worker, `/operate/voice`, choose **The Ministry**, **Confidential**, send. Note the `MV-` code.
2. As a company administrator: Voice review shows **nothing** for it, and no notification arrived.
3. As a Ministry administrator: bell shows a generic notice; **Worker Reports** lists it with company and
   site; the identity is not shown. Open it with a purpose; as the worker, "Your named and confidential
   reports" shows it was opened once.
4. As a national supervisor: the same report is visible; opening the confidential identity is refused.
5. Signed out, `/voice`, choose **The Ministry**, enter the site code, send anonymously. Check it at
   `/voice/status` with the `MV-` code: stage only. Post an update as a reviewer; it appears there.
6. In the database: `select count(*) from audit_log where entity_type like 'ministry_voice%';` is 0 and
   `ministry_voice_reports` has no identifying columns.

## Rollback

Hide the feature: remove the `voice-ministry` route in `src/main.tsx`, the **Worker Reports** nav entry in
`PortalLayout.tsx` and the channel choice in `VoiceReport.tsx` (the data stays). Remove the data:
`drop table ministry_voice_events, ministry_voice_identity, ministry_voice_reports;` then drop the `mg_mv_*`
functions and the `mv_forget_reporter` trigger on `profiles`, and delete `worker_voice` notifications whose
`link_to` is `/portal/voice-ministry`. Reports are never deleted by the app, so export first if they must be kept.

## Decisions and remaining risks

1. **Who reviews.** Implemented: Ministry administrators + national supervisors. If another Ministry unit
   (a labour inspectorate role) should review, change `mg_mv_user_is_reviewer`. County-scoped supervisors
   are deliberately excluded (they could otherwise see reports about companies outside their area).
2. **Who opens a confidential identity.** Implemented: Ministry administrators only, purpose required,
   recorded. Change `mg_mv_user_is_custodian` for an ombuds role or two-person approval.
3. **No path from a Ministry report to the company in the app.** Reviewers act outside MineGuard
   (inspection, corrective action, letter). Linking a report to an inspection or corrective action is future work.
4. **Small sites and named companies weaken anonymity**; the app says so but cannot fix it.
5. **Allegations, not findings.** Company counts in the overview are not a compliance score and must not be
   used as one; nothing here feeds the risk model.
6. **No two-way anonymous messaging.** One reviewer-written update; the reporter cannot reply.
7. English only.

## Hardening (migration 0052)

The Ministry channel gained, in addition to what is above: **its own intake code** per site (company people cannot
rotate or pause it, which fixes a gap where a company could cut off anonymous reports about itself); messaging with
reporters by follow-up code; photos (JPEG, validated, refused if they carry hidden data); small-site protections;
reviewer push and daily reminders; **trends and companies for attention** (counts with limits, never a prediction);
**retention, legal hold and counts-only disposal** (Ministry administrators); and **requests to a company**
(template topics, only when at least three reports match, never linked to a report). Details, deployment and
rollback are in `docs/22_WORKER_VOICE.MD` ("Hardening").
