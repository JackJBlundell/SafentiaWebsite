# Safentia operator runbook

The day-to-day operating guide for the platform owner. It covers deploying,
what runs on a schedule, backup and restore, the operator scripts, and the
handful of incidents worth knowing the response to.

This runbook points at `SETUP.md` for step-by-step procedures rather than
duplicating them. There is a single Firebase project today, `safentia-tech`
(the only alias in `.firebaserc`); a second dev/prod project does not yet exist.

## Deploying

### Automated (GitHub Actions)

`.github/workflows/deploy.yml` builds the web console and deploys hosting,
functions, database rules and Storage rules together, so code and the rules it
depends on can never skew. It runs on `workflow_dispatch` (manual) and on push
to `main`. The deploy only happens when the `FIREBASE_TOKEN` repository secret
(from `firebase login:ci`) is configured; without it the job still runs but
every deploy step is skipped as a green no-op, so enabling continuous deployment
is purely a secrets change. Two deploys never run at once (the workflow has a
no-cancel concurrency group) so hosting, functions and rules stay consistent.

### Manual (from a workstation)

Requires the Firebase CLI authenticated for `safentia-tech`.

```sh
# Everything, matching the CI deploy:
firebase deploy --only hosting,functions,database,storage --project safentia-tech

# Functions only (there is an npm alias in functions/package.json):
cd functions && npm run deploy
```

The functions predeploy hook (in `firebase.json`) runs the TypeScript build, so
a type error fails the deploy before anything ships.

## Scheduled functions

All three are region-pinned and run in the `Europe/London` timezone. They are
exported from `functions/src/index.ts`; the source is under
`functions/src/functions/`.

| Function | When | What it does |
| --- | --- | --- |
| `exportBackups` | 02:30 daily | Full nightly JSON export of the RTDB (`live`, `test`, `platform` roots, one file each) to `backups/{date}/` in the default Storage bucket. See Backups below. |
| `cleanupLeads` | 03:15 daily | Enforces the privacy policy's 24-month retention: deletes any `/platform/leads` entry older than 730 days (and any malformed record that cannot prove its age). |
| `cleanupBilling` | 03:45 daily | Trims billing bookkeeping in both envs: Stripe webhook idempotency done-markers older than 30 days, and finance-feed / email-log entries older than 12 months. |
| `cleanupExpiredOrgs` | 04:15 daily | **Data-retention reaper (DESTRUCTIVE).** Erases organisations whose 12-month post-cancellation retention clock has elapsed. **REPORT-ONLY unless armed** — see Organisation offboarding below. |
| `reviewReminders` | 07:30 daily | Sends FRA review due-date reminders. For every building whose review falls 60, 30 or 7 days ahead, or lapsed yesterday, it sends one in-app notification (plus best-effort push) and one branded email to each active org admin. Idempotent per building per day. |

A same-day scheduler redelivery is safe: `exportBackups` overwrites that day's
files, and `cleanupLeads` / `cleanupBilling` / `reviewReminders` are idempotent
(the last claims a per-building per-day marker under `/{env}/ops/reviewReminders`
before sending). `cleanupExpiredOrgs` is idempotent too: a re-run against an
already-erased org removes already-absent nodes, a no-op.

## Backups and restore

The nightly `exportBackups` job and the full restore procedure are documented in
`SETUP.md`, section "Backups and restore". Key points to remember:

- The JSON export covers the RTDB only. Storage objects (photos, floor plans,
  flag composites, documents, report PDFs) are NOT in it. They are protected by
  **bucket object versioning, which the owner must enable once** in the Google
  Cloud console before real customer data arrives (see SETUP.md).
- Prefer a partial restore (one org, one node) whenever the incident is scoped;
  a whole-root restore rolls back every tenant.
- A restore re-fires onWrite triggers against the restored data. Restore during
  a quiet window and verify a signed-in client afterwards.

## Operator scripts

All run from `functions/` with `GOOGLE_APPLICATION_CREDENTIALS` pointing at a
service-account key. Full argument detail is in each script's header comment and,
for the first two, in `SETUP.md`.

### Granting and revoking super admin

`functions/src/scripts/grantSuperAdmin.ts` grants platform-oversight access (the
read-only console at `/app/admin`) to one existing account by email. It merges
`superAdmin: true` into the account's claims, sets the durable marker at
`/platform/superAdmins/{uid}`, and stamps the token-refresh marker so the change
takes effect within seconds. See `SETUP.md`, "Granting super admin".

```sh
cd functions
GOOGLE_APPLICATION_CREDENTIALS=<key.json> \
  npx ts-node src/scripts/grantSuperAdmin.ts operator@example.com
```

To revoke: remove `/platform/superAdmins/{uid}` and remove the `superAdmin` key
from the account's custom claims (the console read cascade in
`database.rules.json` is the real security boundary, not the navigation gate). A
later membership change to the account also strips the claim automatically, since
claims are recomputed wholesale from the member record; the marker survives, so
re-run the grant script if the account should keep oversight.

### Report metadata backfill (before portal launch)

`functions/src/scripts/backfillReportMetadata.ts` stamps `customerId` custom
metadata onto historical report PDF objects so portal users can read their own
past reports. It is a dry run by default; re-run with `--apply` to write. Run it
once before opening the portal. Full instructions: `SETUP.md`, "Before portal
launch".

### Organisation data export (SAR / off-boarding)

`functions/src/scripts/exportOrgData.ts` exports all of one organisation's data
under a single environment root to a local JSON file, for a subject-access
request or a tenant data export. It is strictly read-only and never writes back.

```sh
cd functions
GOOGLE_APPLICATION_CREDENTIALS=<key.json> FIREBASE_DATABASE_URL=<rtdb-url> \
  npx ts-node src/scripts/exportOrgData.ts <orgId> [--env live|test] [--out <file>]
```

`--env` defaults to `live`. The written file path and byte count are echoed to
stdout. It exports every org-scoped collection (profile, members, customers,
contacts, sites, buildings, templates, jobs, assessments, actions, documents,
log book, activity, email log, invitation summaries and more) and deliberately
excludes the tokenised `/invitations` tree; a redaction pass masks any
secret-looking value as belt-and-braces.

### Organisation immediate deletion (on request)

`functions/src/scripts/deleteOrganisation.ts` **permanently erases all of one
organisation's data** — the manual counterpart to the nightly retention reaper,
for a customer who asks for deletion before their 12-month clock elapses
(DECISIONS §8). It is a **dry run by default**; pass `--apply` to actually
delete. Take (or confirm) a fresh `exportOrgData` first — the erase is
irreversible.

```sh
cd functions
# 1. Dry run — prints exactly what WOULD be erased, writes nothing:
GOOGLE_APPLICATION_CREDENTIALS=<key.json> FIREBASE_DATABASE_URL=<rtdb-url> \
  npx ts-node src/scripts/deleteOrganisation.ts --org <orgId> --env live
# 2. Then, only after reading the dry-run report, apply:
GOOGLE_APPLICATION_CREDENTIALS=<key.json> FIREBASE_DATABASE_URL=<rtdb-url> \
  npx ts-node src/scripts/deleteOrganisation.ts --org <orgId> --env live --apply
```

`--env` defaults to `live`. Both the script and the sweep share one deletion
core (`functions/src/lib/deleteOrgData.ts`), so they erase identically:

- **every org-scoped RTDB subtree** (organisation profile/settings/subscription/
  usage, members, customers, contacts, sites, buildings, building access, floor
  plans, templates + drafts + versions, standard paragraphs, jobs + assessor
  index, assessments + answers, actions, documents, log book, reports,
  notification ledger, activity, email log, email templates, email settings, and
  the per-org `ops` notification/manual-email counters);
- the org's **per-user reverse-index entries** (`userOrgs/{uid}/{orgId}` and each
  portal `customerUserIndex/{uid}/{orgId__customerId}`) and the **Stripe reverse
  markers** (`stripeCustomers`, `provisionedSubs`);
- the whole **`{env}/orgs/{orgId}/` Storage prefix** (photos, floor plans, flag
  composites, documents, action evidence, org assets, report PDFs).

It appends one `org_deleted` entry to the super-admin finance feed.

**Deliberately NOT deleted** (documented exclusions): Firebase **Auth accounts
are left intact** — a person may belong to other orgs, so deleting their login is
unsafe to automate; instead their membership + reverse-index entries go, and
their claims are stripped of this org when they still point at it (their next
token refresh routes them cleanly). Also excluded: the tokenised global
`/invitations` tree (keyed by inviteId, not orgId — a stray bearer token is
useless once the org is gone), per-user `/notifications/{uid}` (may mix several
orgs), the `ops/stripeEvents` idempotency markers (swept on their own 30-day
clock), and the `platform/financeEvents` billing audit feed (a financial record
swept on its own 12-month clock — the deletion appends to it, never erases it).

### Data-retention reaper (`cleanupExpiredOrgs`) and the arming flag

On **final** subscription cancellation the Stripe webhook stamps
`organisations/{orgId}/subscription/retentionUntil = now + 12 months`; a
resubscribe clears it, so a returning customer is never reaped. The nightly
`cleanupExpiredOrgs` sweep finds orgs whose clock has **elapsed** and erases them
via the same core above, capped at 25 orgs per run.

**It is REPORT-ONLY by default.** It always logs which orgs it *would* reap
(`Retention elapsed but deletion NOT armed`), but performs no deletion unless the
functions runtime env carries:

```
FIRERITE_ENABLE_RETENTION_DELETION=true
```

Any other value (unset, `false`, …) leaves it in the safe dry-run posture. Leave
it **unset** until the data-retention privacy copy is signed off (see below);
watch the candidate logs first, then arm it deliberately.

> **CLIENT SIGN-OFF REQUIRED.** The customer-facing retention/deletion copy — the
> 12-month post-cancellation window, export-on-request and operator-performed
> deletion — is a contractual blocker not yet approved (DECISIONS §9). Do not arm
> automated deletion, and do not go live, until that wording is published and the
> client has signed it off.

## App Check enforcement

Callable functions require a verified App Check token by default: the shared
callable wrapper sets `enforceAppCheck` (`functions/src/lib/callable.ts`) and the
`assertAppCheck` guard (`functions/src/lib/guards.ts`) rejects unattested
requests. On the web the token is minted with reCAPTCHA v3.

Enforcement can be turned off for an environment that has not yet registered App
Check providers by setting `FIRERITE_ENFORCE_APPCHECK=false` in the functions
runtime environment. Production leaves it unset (enforced). If legitimate clients
start failing with an App Check error immediately after enabling enforcement,
confirm the web build carries a valid reCAPTCHA site key (see below) and that the
key is registered as an App Check provider in the Firebase console.

## reCAPTCHA and email (Resend) configuration

These are configured once and pointed at from the code comments; keep the keys
with the rest of the project secrets.

- **reCAPTCHA v3 site key** (App Check on the web): set
  `VITE_RECAPTCHA_V3_SITE_KEY` at web build time. It is public by design. When it
  is empty, the web App Check provider is not initialised. See `SETUP.md`,
  "Environment keys".
- **Email provider (Resend)**: the API key is the `EMAIL_PROVIDER_API_KEY`
  Firebase secret, attached per-function via `EMAIL_PROVIDER_SECRETS`. When no
  key is configured, email dispatch is skipped (the intent is logged) and no
  business operation is rolled back. Until the sending domain is verified in
  Resend, only the Resend account owner's address receives mail. See `SETUP.md`,
  "Environment keys".

## Common incidents

- **Callables suddenly return unauthenticated / CORS errors for everyone.** The
  most common cause is a functions redeploy that dropped the public-invoker IAM
  binding. Redeploy functions (`firebase deploy --only functions`) to restore the
  binding; the callable contract itself is unchanged.
- **A console page throws and shows a fallback screen.** The web console is
  wrapped in an `ErrorBoundary` (`src/console/ui/ErrorBoundary.tsx`), so a render
  crash is contained to that view rather than blanking the app. Reproduce the
  route, check the browser console and (if wired) the client-error log, then fix
  and redeploy hosting.
- **Portal users cannot open their own historical reports.** Their PDFs predate
  the `customerId` metadata stamp. Run the report metadata backfill (above).
- **Emails are not arriving.** Either `EMAIL_PROVIDER_API_KEY` is unset (dispatch
  is skipped and logged, by design) or the recipient is not the Resend account
  owner while the domain is still unverified. Verify the domain in Resend.
- **Review reminders did not go out.** Check the `reviewReminders` function logs
  for the day; a per-building per-day marker under `/{env}/ops/reviewReminders`
  means a notice was already claimed and sent, so it will not be re-sent.
- **A bad write needs rolling back.** Restore the affected node from the most
  recent nightly backup (partial restore preferred). See Backups and restore.

## Where things live

- Operator procedures with full steps: `SETUP.md`.
- Deploy workflow: `.github/workflows/deploy.yml`; project alias in `.firebaserc`.
- Scheduled functions: `functions/src/functions/` (exported from
  `functions/src/index.ts`).
- Operator scripts: `functions/src/scripts/`.
- Security rules: `database.rules.json`, `storage.rules`.
