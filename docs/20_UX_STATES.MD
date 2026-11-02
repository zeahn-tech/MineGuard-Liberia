# 20 — UX states: error, offline, slow, empty, loading and the rest

Ten states every screen can be in, and the one shared piece of code that
handles each, so no screen invents its own. The standard for all ten: **say what
is happening, whose side it is on, and what to do next — and never leave a blank
screen or a dead end.**

| # | State | What the person sees | Where it lives |
|---|---|---|---|
| 1 | **Error** | What went wrong, whose side (yours / the connection / your account / this device / ours), how to fix. Raw codes and SQL never reach the screen; a short reference does, for support. | `lib/error-messages.ts` (`describeError`), `lib/feedback.ts` (`toastError`, `toastProblem`), `RootErrorBoundary` |
| 2 | **No internet** | A bar in every sticky header: "You're offline. Showing what was last loaded on this device…", the count waiting to send, and "Back online" on return. | `OfflineBanner`, `hooks/use-online.ts`; mounted in the three shells and `PublicHeader` |
| 3 | **Slow network** | After 4 s: real seconds waited, how much has loaded when known, "we keep retrying". After 12 s: **Try again** and a **light path** (report an incident — it saves on the device first). Nothing is invented: no fake percentages. | `PageLoading`, `lib/load-phase.ts`, `LightPathProvider` |
| 4 | **No search results** | "No results for “x”." plus "Did you mean…?" — only when the corrected search would really return something. | `NoResults`, `lib/did-you-mean.ts`, `lib/tracking-code.ts` |
| 5 | **Permission denied** | Why we ask, how to allow it, and a way on without it (continue without GPS; pick a photo instead). | `PermissionNotice`, `lib/camera-reason.ts`, `lib/site-position.ts` |
| 6 | **Session expired** | A 60 s warning with a countdown and **Stay signed in**; then "You were signed out. For your safety we sign you out after 30 minutes of inactivity. Your work is kept…". | `SessionGuard`, `lib/session-expiry.ts`, `signOutIdle`, `lib/form-drafts.ts`, `useFormDraft` |
| 7 | **Form validation** | The exact field is outlined and says how to fix it, announced to screen readers; focus moves to the first problem. | `FormField`, `lib/validation.ts`, `lib/form-rules.ts` |
| 8 | **Success** | Confirm what happened, reassure (what was kept / what is true now), and offer the next step. A queued save never says "submitted". | `toastSuccess` |
| 9 | **Empty** | What is empty, *why*, and exactly one next step (omitted when the person can't act, and the copy says who can). | `EmptyState` |
| 10 | **Loading** | The silhouette of what is coming — list, cards, table, detail, form — not a spinner. | `PageLoading` shapes, `RouteLoading` |

## How a timeout keeps work safe (state 6)

* **Idle limit 30 minutes**, shared across tabs (`mg.session.lastactive.v1`).
* **Offline: the sign-out is deferred.** A field worker who is idle without
  signal must not be locked out of an app they can't sign back in to; if they are
  still idle when the connection returns, the sign-out happens then.
* `signOutIdle` signs out **without wiping anything on the device**. An explicit
  *Sign out* still follows the shared-device rule (wipe unless something is
  waiting to be sent), and now also clears form drafts under that same rule.
* In-progress report forms (`useFormDraft`) are saved per signed-in user,
  verified on write, debounced, flushed when the page hides or the form closes,
  dropped after 14 days, and **never written back after a successful submit**
  (a regression test mutation-checks this).
* An unrequested sign-out (token expired/revoked, ended in another tab) leaves a
  note for the sign-in screen, which says why — once. The person returns to the
  page they were on.
* Disclosed in `/cookies`.

## Honest limits

* **"Showing what was last loaded"** is the in-memory cache of the current
  session. It is not persisted between visits: a page never opened since the app
  started shows the offline loading state, not old data. Persisting reads across
  visits needs stable cache keys and a privacy design (cached oversight data on
  shared devices) and has not been built.
* Drafts hold what was typed. **Attached files and the map position are not kept
  in drafts**, and the restore notice says so.
* `BoundaryLoader` (an admin data tool) keeps its own literal "Loading..." text,
  asserted by its own tests. Two-factor and template errors keep their existing
  domain-specific mappers (`friendlyMfaError`, `friendlyError`), which already
  meet the standard.
* County names on site registration get a non-blocking "Did you mean…?"; unknown
  values are not rejected, so a legitimate spelling is never locked out.

## Guarding it

* `tests/ux-states-lib.test.ts` — error descriptions, did-you-mean, validation
  rules, tracking codes, idle timing.
* `tests/ux-states-components.test.tsx` — rendered offline banner, loading
  phases, empty/no-results, field wiring.
* `tests/session-guard.test.tsx`, `tests/form-drafts.test.ts` — the timeout and
  the drafts, in real time.
* `tests/ux-states-contract.test.ts` — source guards: no bare "Loading…", no raw
  `e.message` toasts, no validate-by-toast, every shell keeps its guard and
  banner, queued saves never say "submitted".
