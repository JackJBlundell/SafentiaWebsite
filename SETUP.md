# Safentia operational setup

Operator-run procedures that are not part of a deploy. Add sections additively;
each one should say what it does, what it needs and how to run it.

## Granting super admin (FR-E24)

Platform oversight (the read-only console at `/app/admin`) is gated by a
`superAdmin: true` custom claim on the operator's account. Grant it with the
script in `functions/src/scripts/grantSuperAdmin.ts`:

```sh
cd functions
GOOGLE_APPLICATION_CREDENTIALS=<service-account-key.json> \
  npx ts-node src/scripts/grantSuperAdmin.ts operator@example.com
```

What it does:

1. Merges `superAdmin: true` into the account's existing custom claims (the
   account keeps its normal organisation claims).
2. Sets `/platform/superAdmins/{uid}` to `true` - the durable record of the
   grant, and what the `/platform` read rule checks.
3. Stamps the token-refresh marker so a signed-in session picks the claim up
   within seconds.

Notes:

- The account must already exist; the script never creates users.
- The console is read-only oversight by design: no screen under `/app/admin`
  mutates tenant data. The security boundary is the `superAdmin` read cascade
  in `database.rules.json`, not the navigation gate.
- Known interplay: a later membership change to the same account recomputes
  its claims from the member record and strips `superAdmin` (claims are
  replaced wholesale). The `/platform/superAdmins` marker survives; re-run the
  script to re-grant.

## Before portal launch

### Backfill report PDF metadata (portal read access)

Portal users read report PDFs through a Storage rule that checks the object's
custom metadata: `resource.metadata.customerId` must equal the caller's
`customerId` claim. New reports are stamped at generation time; reports
generated before the stamp existed carry none and would be invisible to their
own customer. Run the backfill once before opening the portal:

```sh
cd functions
# Dry run first (default): prints what WOULD be stamped, writes nothing.
GOOGLE_APPLICATION_CREDENTIALS=<service-account-key.json> \
FIREBASE_DATABASE_URL=<rtdb-url> FIREBASE_STORAGE_BUCKET=<bucket> \
  npx ts-node src/scripts/backfillReportMetadata.ts

# Then apply:
GOOGLE_APPLICATION_CREDENTIALS=<service-account-key.json> \
FIREBASE_DATABASE_URL=<rtdb-url> FIREBASE_STORAGE_BUCKET=<bucket> \
  npx ts-node src/scripts/backfillReportMetadata.ts --apply
```

What it does: walks `/{env}/reports` (both roots), resolves each report's
owning customer via `/{env}/buildingCustomerIndex`, and sets
`customMetadata.customerId` on the Storage object where it is absent or empty.
Already-stamped objects are never touched, so re-running is safe. The summary
lists any report whose customer could not be resolved (no index entry) - check
those by hand before launch.

## Backups and restore

### What is backed up, and when

The scheduled Function `exportBackups` runs nightly at 02:30 UK time and writes
a full JSON export of the Realtime Database - the `live`, `test` and `platform`
roots, one file each - to the default Storage bucket under:

```
backups/{YYYY-MM-DD}/rtdb-live.json
backups/{YYYY-MM-DD}/rtdb-test.json
backups/{YYYY-MM-DD}/rtdb-platform.json
```

The `backups/**` prefix is denied to all clients in `storage.rules`; only the
Admin SDK and console operators can read it. The ephemeral `/metadata` and
`/ops` trees (token-refresh markers, rate-limit counters) are deliberately not
exported. A same-night scheduler retry overwrites that day's files rather than
duplicating them.

### Storage objects are NOT in the nightly export

Photos, floor plans, flag composites, documents and report PDFs live in Cloud
Storage, not RTDB, so the JSON export does not cover them. Their protection is
**bucket object versioning, which the owner must enable once in the Google
Cloud console**: Cloud Storage > bucket > Protection > Object versioning (add a
lifecycle rule to cap noncurrent versions, e.g. keep 5 for 90 days). With
versioning on, an overwritten or deleted object's previous generation remains
recoverable; without it, a deletion is final. Do this before real customer data
arrives.

### Restore outline

1. Identify the backup day to restore from and download the relevant
   `rtdb-{root}.json` from the bucket (Cloud console or `gsutil cp`).
2. For a FULL root restore: import the JSON over the root with the Firebase
   console's Database "Import JSON" on that root path, or an Admin SDK
   `db.ref(root).set(parsed)` from a one-off script. This replaces the root
   wholesale - take a fresh export first so the pre-restore state is itself
   recoverable.
3. For a PARTIAL restore (one org, one node): extract the subtree from the
   JSON and `set()` it at the same path. Prefer this whenever the incident is
   scoped; whole-root restores roll back every tenant.
4. Storage objects: restore the needed object generations from bucket
   versioning (console > object > version history, or
   `gsutil cp gs://bucket/object#<generation> ...`).
5. Restores bypass Functions triggers only in the sense that they re-FIRE
   them: expect onWrite triggers (claims, notifications) to run against the
   restored data. Restore during a quiet window and verify a signed-in client
   afterwards.

## Exporting one organisation's data (SAR / off-boarding)

For a subject-access request or a tenant data export, the script in
`functions/src/scripts/exportOrgData.ts` writes all of one organisation's data,
under a single environment root, to a local JSON file. It is strictly read-only
and never writes back to the database.

```sh
cd functions
GOOGLE_APPLICATION_CREDENTIALS=<service-account-key.json> \
FIREBASE_DATABASE_URL=<rtdb-url> \
  npx ts-node src/scripts/exportOrgData.ts <orgId> [--env live|test] [--out <file>]
```

`--env` defaults to `live`. The written file path and its byte count are echoed
to stdout. The script reads every org-scoped subtree the path builder defines
(profile, members, customers, contacts, sites, buildings, templates, jobs,
assessments, actions, documents, log book, activity, email log, invitation
summaries and more), each in one subtree read. It deliberately excludes the
tokenised `/invitations` tree and masks any secret-looking value as a
belt-and-braces redaction pass.

## Environment keys

The keys the app and Functions read at build or run time. They are public or
secret as noted; keep them with the rest of the project configuration.

- **`VITE_RECAPTCHA_V3_SITE_KEY`** (public, web build time). The reCAPTCHA v3
  site key App Check uses on the web (`src/config/env.ts`). An empty value means
  the web App Check provider is not initialised. Register the same key as an App
  Check provider in the Firebase console.
- **`EMAIL_PROVIDER_API_KEY`** (secret, Functions). The Resend API key
  (`functions/src/lib/email.ts`), set with
  `firebase functions:secrets:set EMAIL_PROVIDER_API_KEY` and attached to a
  Function via `EMAIL_PROVIDER_SECRETS`. When it is not configured, email
  dispatch is skipped and logged, and no business operation is rolled back.
  Until the sending domain is verified in Resend, only the Resend account
  owner's address receives mail.
- **`FIRERITE_ENFORCE_APPCHECK`** (Functions runtime). App Check on callables is
  enforced by default; set this to `false` only for an environment that has not
  yet registered App Check providers. Production leaves it unset.
