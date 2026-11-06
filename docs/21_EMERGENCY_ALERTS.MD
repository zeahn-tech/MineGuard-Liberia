# 21 — Emergency Command & Response Coordination (Phase 2)

**Status: implemented, NOT field-validated, NOT approved for operational use.**
MineGuard emergency alerts are a **supplementary** coordination aid. They do not replace a
site's sirens, radios, supervisors or approved emergency procedures, and nothing in this
release may be described as certified or as a sole means of emergency communication until
the field tests in §8 are done and the Ministry / site operator approves it in writing.

## 1. Pre-implementation review (what existed, what was missing)

| Area | Found | Gap addressed |
|---|---|---|
| Emergency screens / alerts | None. "Incidents" are after-the-fact reports; `NotificationBell` is a dismissible inbox. | New alert model, console, worker screen, banner |
| Notification infrastructure | In-app inbox only (`notifications`, migrations 0021/0034). Doc 11 and `tests/notifications.test.ts` state no push channel exists. | Separate emergency channel (inbox deliberately not reused: it is dismissible and not time-critical) |
| Service worker | App-shell + map-tile cache only (`public/sw.js`). No `push`, no `notificationclick`. | Push, click, subscription-change handlers; version bumped to v1.4.0 |
| Push subscriptions | None. | `push_subscriptions` table (secrets, no client read), register/unregister RPCs, re-registration on app start |
| Authentication & roles | Ministry roles + `permissions` matrix (0010); company roles in `organization_members` (0026); per-site `site_assignments` (0027). | `mg_can_manage_emergency` — evaluated live on every call |
| Site / zone data | `sites` (+ `organization_id`). **No zone table.** | Site-level targeting; free-text zone *label* only (does not narrow audience) |
| Worker membership | `organization_members.org_role`, `mg_operator_site_ok` | Audience computed from live membership + target group |
| Audit logging | `mg_audit_row` triggers (0009), append-only for clients | Triggers on all emergency tables; push secrets excluded from audit |
| Offline queue | `offline-queue.ts` + scheduler | New `emergencyAck` kind (acks only — see §5) |
| Existing tests | 1,226 pass / 1 failing (`assignment changes are audit-trailed…`) in the baseline run | 51 new tests; final full run 1,278 pass / 0 fail (that baseline failure did not recur — unrelated, not investigated) |

## 2. Who may do what (server-enforced — migration 0040)

* **Create / activate / update / cancel / resolve:** an active member of the site's *approved* company who is `company_admin`, or a `site_manager` / `safety_officer` **with a live assignment to that site**. (Owner-approved: site managers and safety officers may activate; Ministry roles may **not** create or activate alerts at company sites.)
* **Read + delivery dashboard:** the above, plus Ministry `admin` / `supervisor` / `inspector` inside their existing scope (permission `emergency.read`, read-only).
* **Receive / acknowledge:** the live audience only.
* Revoking a membership, assignment or permission takes effect on the very next call. Client-side checks are courtesy only.
* Migration `0041` removes any leftover `emergency.manage` grant (a database that applied an earlier draft of 0040 needs it) and adds `mg_emergency_manageable_sites()`, which the app uses to show "New alert" and the site list only to people the database would let through. Everyone else sees a read-only list.
* No role holds `emergency.manage`; the hook remains so a future explicit grant is a data change.

## 3. Alert model
`emergency_alerts` — title, severity (advisory/warning/critical), instructions, assembly point, procedure reference, zone label, target group (all / workers / safety officers / site managers), status (draft → active → cancelled | resolved), revision, creator, activator, closer + reason, timestamps. `emergency_alert_revisions` is the append-only update/cancellation history.

Safeguards: confirmation word checked **by the server** (ACTIVATE / UPDATE / CANCEL / RESOLVE); `expected_revision` on every change (stale and replayed requests refused); create is idempotent per `(user, idempotency_key)`; an identical alert cannot be activated twice for a site; an active alert's audience cannot be widened; updates to an active alert require a note workers can see. Activation / cancellation are **never queued offline**.

## 4. Delivery & acknowledgment — what each state does and does not mean
| State | Source | Means | Does **not** mean |
|---|---|---|---|
| Created / Activated / Updated / Cancelled | database | the alert exists in that state | anyone was told |
| Push *queued* | outbox row | waiting to be handed to the push service | sent |
| Push *service accepted* | HTTP 2xx from vendor push service | vendor took the message | device received it / worker saw it |
| Push *rejected / expired* | HTTP 4xx / 404 / 410 | message refused / registration gone | — |
| Push *not configured* | no VAPID keys | nothing sent | — |
| *Displayed (reported)* | worker's app, `mg_emergency_mark_displayed` | the app says it rendered the alert | independently verified |
| *Acknowledged* | worker pressed the button; actor = session user; server time | that account pressed it for that revision | the worker is safe / evacuating |
| *No acknowledgment* | — | unknown | worker is unsafe, unaware or failed to evacuate |

The dashboard prints these limits on screen. After an update, earlier acknowledgments are kept but shown as "earlier version".

## 5. Offline & unreliable connectivity (designed behaviour)
| Situation | Behaviour |
|---|---|
| Worker offline at activation | Not reached by push or in-app. On reconnect / tab focus / 30 s poll the app fetches active alerts. **No promise of instant delivery.** |
| Reconnects later | Alert appears; closed alerts stay visible 24 h so a cancellation is learned too |
| Offline while viewing | Last-known alert shown with a banner: "may be out of date… rely on radio, sirens and your site's procedure" |
| Acknowledge offline | Saved on device first; screen says "not yet received by the server"; syncs with backoff; a late ack of a cancelled alert is recorded as late, not lost |
| Alert changes while offline | Next fetch shows the new revision and asks for a fresh acknowledgment |
| Push permission denied / unsupported / no HTTPS / no VAPID | Card explains in plain words; in-app alerts still work while the app is open |
| Subscription expires | Dispatcher marks it expired on 404/410; app re-registers on next start; SW tells open windows on `pushsubscriptionchange`. Until then the device is unreachable by push |
| Push service down | rows stay *queued* and are retried (max 5 attempts, 6-hour limit; automatically once the sweep is scheduled); dashboard shows "waiting to send"; manager can "Retry push delivery" |
| Old cached app | Server reports `api_version`; a newer server makes the app ask for a reload. A shell that predates this release shows nothing — see §8 |

## 6. Audit trail
Every table row change is written by the database (`mg_audit_row`): creation, activation, updates, cancellation, delivery-state changes, acknowledgments, views, with actor and time. History/ack/view tables also refuse UPDATE/DELETE from anyone (trigger). Ordinary users have no write grants on any emergency table or on `audit_log`. Push endpoints/keys are never audited. Note: `audit_log` is already readable by all staff roles in this system, so alert text in audit details is visible to staff.

## 7. Notification dependencies (required for push; none are set up by this PR)
1. A VAPID key pair (`npx web-push generate-vapid-keys`).
2. Edge Function secrets: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `INVITE_ALLOWED_ORIGIN`; deploy `supabase functions deploy emergency-dispatch --use-api`.
3. Build variable `VITE_VAPID_PUBLIC_KEY` (same public key) for the web app. Without it the app says push is not set up.
4. HTTPS origin; browser support for Push API + service workers (iOS only for installed home-screen web apps on supported versions; some Android battery-saver modes suppress push).
5. Scheduled retries (approved): set secret `EMERGENCY_SWEEP_SECRET`, enable `pg_cron` + `pg_net`, and run `supabase/cron/emergency-dispatch-sweep.sql` (commented template — not applied by migrations). Every minute it retries undelivered rows younger than 6 hours (max 5 attempts); older rows are closed out as "not sent", never pushed late. If cron is unavailable, a manager's "Retry push delivery" button is the fallback.
6. Realtime: `emergency_alerts` is added to the `supabase_realtime` publication as a speed-up; polling is the fallback.

## 8. Manual field-testing required before any operational claim
* Real devices (low-end Android, iOS home-screen app) in underground / pit / low-coverage areas: time from activation to display, to push, to acknowledgment.
* Push with screen locked, battery saver on, data saver on, app closed for days, notifications blocked, subscription rotated.
* Device with the previous app version cached (before this release) — confirm what a worker actually sees.
* Shared devices / sign-out then another user; shift change.
* Accessibility on glare / gloves / large text; local-language review of wording.
* Drill with the site's real procedure: confirm sirens/radios remain primary and the alert text matches the approved procedure.
* Load: audience of the largest site; dispatcher time to hand off all subscriptions.
* Written approval by the Ministry and the site operator.

## 9. Security tests (`tests/emergency-alerts.test.ts`, `tests/emergency-client.test.ts`)
Unauthorized create/activate/update/cancel (worker, other company, anonymous, unassigned manager) · cross-site / cross-company · revoked membership & assignment · Ministry read-only roles · missing/incorrect confirmation · stale revision, replayed activation, duplicate create, duplicate active alert, racing managers · audience limits and target groups · removed member loses access · acknowledgment attribution (no user parameter exists; forged/other-user refused) · idempotent ack · late ack · direct table writes and audit tampering refused · append-only even for owner · push secrets not readable and not audited · dispatcher service-role only, caller authorized first, private/non-https endpoints never contacted, no instructions in push payload · offline queue persistence/dedupe/refusal/backoff · service worker handlers.
**Not testable in this environment:** real browsers / real push services / real network loss (see §8); Playwright a11y e2e was not run; expired-session behaviour relies on the existing auth layer (RPCs reject without a JWT).

## 10. Files changed
New: `supabase/migrations/0040_emergency_alerts.sql`, `supabase/migrations/0041_emergency_authority_corrections.sql`, `supabase/functions/emergency-dispatch/index.ts`, `supabase/functions/_shared/emergency/dispatch.ts`, `src/lib/emergency.ts`, `src/hooks/use-my-emergency-alerts.ts`, `src/components/emergency/*`, `src/pages/emergency/*`, `tests/emergency-alerts.test.ts`, `tests/emergency-client.test.ts`, this document.
Modified: `public/sw.js` (push handlers, v1.4.0), `src/lib/offline-queue.ts` (+`emergencyAck`), `src/components/QueueManager.tsx`, `src/pages/operate/OperatorLayout.tsx` and `src/pages/PortalLayout.tsx` (nav, banner, sync binding), `src/main.tsx` (routes), `src/vite-env.d.ts`.
Pinned-count tests updated for the new migration: `tests/migration-apply.test.ts` (tables 29→35, RLS 29→35, touch triggers 15→20, audit triggers 19→24, permissions 21→25, read-only table set, client RPC allowlist, end-state restore list). `src/pages/Cookies.tsx` discloses the new `mg.emergency.last.v1` storage key.

## 11. Rollback
* **App:** revert the commit / redeploy the previous build (the SW version change makes devices fetch it). Alert data is harmless to older app versions (they ignore it).
* **Stop new activations without a redeploy:** `revoke execute on function public.mg_emergency_activate(uuid,text,integer) from authenticated;` (re-grant to restore). Alerts already active remain visible and can still be cancelled.
* **Database (destructive — loses emergency history; export first):**
  `drop table public.emergency_alert_deliveries, public.emergency_alert_views, public.emergency_alert_acks, public.emergency_alert_revisions, public.emergency_alerts, public.push_subscriptions cascade;` then drop the `mg_emergency_*`, `mg_can_manage_emergency`, `mg_can_view_emergency`, `mg_register_push_subscription`, `mg_unregister_push_subscription`, `mg_my_push_status`, `mg_my_emergency_alerts` functions and `delete from public.permissions where permission like 'emergency.%'`.
* **Function:** `supabase functions delete emergency-dispatch`.
