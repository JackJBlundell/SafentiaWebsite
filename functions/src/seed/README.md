# Safentia seed (Phase 1)

The single, idempotent seed for the shared canonical demo world (brief 10,
stories 1014 + 1015). It writes ONLY under the isolated `/test` data root
(brief 4.8) and refuses to run if any path would touch `/live`. It is the world
the mobile app uses now and the Phase 2 web app will reuse.

## One-command invocation

Against the local emulators (recommended for development):

```bash
# from fireritesite/ (the Firebase root)
firebase emulators:exec --only database,auth,storage --project safentia-tech \
  'USE_EMULATOR=true npm --prefix functions run seed'
```

Or, with emulators already running:

```bash
# from fireritesite/functions/
USE_EMULATOR=true npm run seed
```

Against a real project (`safentia-tech`), copy `.env.example` to `.env`, set
`GOOGLE_APPLICATION_CREDENTIALS` to a service-account JSON, then:

```bash
# from fireritesite/functions/
npm run seed
```

The seed reads its target from `.env.example`-documented variables
(`USE_EMULATOR`, `*_EMULATOR_HOST`, `GOOGLE_APPLICATION_CREDENTIALS`,
`FIREBASE_PROJECT_ID`, `FIREBASE_DATABASE_URL`, `FIREBASE_STORAGE_BUCKET`).

## Sign in as the seeded assessor

The seed prints these on completion:

```
email    : alex.assessor@firerite-demo.test
password : Safentia-Test-2026!
```

Other roles share the same password (`dana.admin@`, `priya.auditor@`,
`tom.finance@`, `sam.viewer@`, and the multi-role `jordan.adminassessor@`).

## What gets created (all under `/test`)

- **1 organisation** with brand colours, a font family, a generated logo and
  contact details (whitelabel theming is demonstrable on first sign-in).
- **6 members** covering every org role plus one multi-role (admin+assessor)
  user, all `testMode: true`, each with a matching Firebase Auth account.
- **PAS 79-1:2020 template**, published immutable v1, all 12 sections, every
  question type, photo / non-conformity / flag-location questions, guidance and
  required markers.
- **3 customers, 4 sites, 6 buildings** with the full detail set and TRUE
  `ragDistribution` mixes (some mostly green with a touch of red, to prove the
  proportional gauge is not all-red).
- **5 floor plans** across some buildings; two buildings (Central Annexe,
  Harbourside Unit) deliberately have none.
- **5 jobs** for the seeded assessor spanning scheduled .. released.
- **4 assessments**: two released (with history, photos, a flag and actions),
  one `readyForValidation`, one `infoRequired` with an OPEN info request on a
  question. Two buildings have no assessment (pending).
- **Actions** across L/M/H severities, some Life Protection, some carrying a
  flag-location composite image; one is pre-signed-off.
- **Log book** entries of all six types.
- **Real PNG media** (logo, floor plans, building photos, answer photos and a
  flag composite with R/A/G pins) generated in-process and uploaded to the
  env-scoped Storage paths.

## Idempotency

Every record uses a deterministic id and is written with `set()`. Auth users use
fixed uids (created, or updated if they already exist). Re-running produces no
duplicates and leaves the world in the same state (story 1014 AC2).
