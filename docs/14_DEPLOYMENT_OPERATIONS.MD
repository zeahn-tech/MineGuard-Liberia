# 14 — Deployment & Operations

**Status:** Firebase backend wired and verified at the config level; one-time
Firebase console activation by the project owner is pending.

## Current topology

- Vite SPA (Freebuff-managed dev server, HMR disabled by platform policy).
- Firebase project `mineguard-liberia`:
  - **Cloud Firestore** — all domain data (collections per doc 03).
  - **Firebase Authentication** — email/password + anonymous guest.
  - **Cloud Storage for Firebase** — evidence media under `evidence/{uid}/`.
- No standalone API servers; no containers to manage.
- Firebase web config lives in `src/lib/firebase.ts` (public client
  identifiers by design; security is in the rules, not the config).

## One-time Firebase activation checklist [REQUIRED — project owner]

The Firebase project exists and the API key is valid, but two services must be
activated in the console before the app can reach the backend:

1. **Create the Firestore database** — Firebase console → *Build → Firestore
   Database → Create database* (production or test mode; the deployed rules
   lock it down either way).
2. **Enable sign-in providers** — *Build → Authentication → Get started →*
   enable **Email/Password** and **Anonymous**.
3. **Deploy the security rules** (from the repo root, requires Firebase CLI
   login):
   ```bash
   npx firebase deploy --only firestore:rules,storage
   ```
   The repo ships `firestore.rules`, `storage.rules`, `firebase.json` and
   `firestore.indexes.json` for exactly this purpose. Alternatively paste the
   two rule files into *Firestore → Rules* and *Storage → Rules* in the
   console.
4. **First admin bootstrap** — sign in on the app with an email/password
   account and complete the staff profile; the first profile becomes the
   platform administrator (guarded by `meta/hasStaff`; audit logged). All
   further roles are assigned through *Assign roles*.

## Environment variables

No backend keys are required in this environment. The Firebase web config
(apiKey, authDomain, projectId, storageBucket) is embedded in
`src/lib/firebase.ts` and is public by design — authorization never depends on
its secrecy.

If the project is ever self-hosted with different Firebase credentials, move
the config values into `VITE_FIREBASE_APIKEY`, `VITE_FIREBASE_AUTHDOMAIN`,
`VITE_FIREBASE_PROJECTID`, `VITE_FIREBASE_STORAGEBUCKET` build variables and
read them in `src/lib/firebase.ts` — never commit separate credentials.

## Environments

| Environment | Purpose | Data |
|-------------|---------|------|
| Development | Feature work; demo seed allowed | Synthetic only |
| Production (future) | Pilot operations | Real records; seed prohibited |

## Deployment checklist (pilot) [PLANNED]

1. `bun run build` + typecheck green in CI.
2. Firebase activation checklist above completed; rules deployed.
3. First admin account bootstrapped; then all other roles assigned through the
   admin UI (`provisionByEmail` requires the target to have signed in once).
4. Demo seeder disabled/removed in production builds.
5. Custom domain added to Firebase Auth authorized domains for sign-in.
6. Backups: Firestore scheduled exports (PITR enabled); restore tested.
7. Tile source reviewed (self-host or vendor) for reliability.

## Operational runbook notes

- **Seeded demo data:** clearly stamped "Synthetic demonstration record" in site
  notes; audit entry `system.seed` records the run. Never run in production.
- **Role provisioning:** requires the target email to sign in once; audit logged
  as `user.role.set`.
- **Sync incidents:** field users can force sync from the topbar; queued items
  persist across sessions; check `mg.offline.queue.v1` contents when supporting
  a field device.
- **Audit review:** `/portal/audit` shows the last 200 entries; longer retention
  requires an export job [PLANNED].

## Monitoring [PLANNED]

- Firebase console: Firestore usage, auth events, rule denial metrics.
- Client-side error boundary reporting (currently console-only).
- Uptime probe on the SPA.

## Known operational limits

- Evidence storage growth unbounded except the 25 MB/file cap; footprint metric
  exists (`storageFootprint`), retention policy needs government confirmation.
- Single-region deployment (Firestore default); disaster recovery = scheduled
  exports + documented restore test.
- Security rules cannot fully express county-scoped list filters; enforced in
  the data layer (see doc 04, gap 5).
