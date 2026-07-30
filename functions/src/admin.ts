// ============================================================================
// firebase-admin initialisation - done exactly ONCE for the whole codebase.
//
// Every Function imports the typed handles (db, auth, storage) from here rather
// than calling initializeApp itself, because a second initializeApp in the same
// process throws, and because the admin SDK bypasses security rules - so the one
// place it is wired up is the one place to reason about that privilege.
//
// Emulator wiring: when the standard Firebase emulator env vars are present (the
// CLI sets DATABASE_EMULATOR_HOST etc. automatically under emulators:exec) or the
// project's own USE_EMULATOR flag is set, the SDK talks to local emulators. This
// is read from the environment, never hard-coded, so the same build runs locally
// and in production untouched.
// ============================================================================

import { initializeApp, getApps, App } from 'firebase-admin/app';
import { getDatabase, Database } from 'firebase-admin/database';
import { getAuth, Auth } from 'firebase-admin/auth';
import { getStorage, Storage } from 'firebase-admin/storage';
import { REGION } from './lib/region';

/**
 * True when the process is pointed at local emulators. The Firebase CLI exports
 * the *_EMULATOR_HOST vars under `emulators:exec`; USE_EMULATOR is our own opt-in
 * for the seed/admin scripts (see .env.example). Either signal counts so a
 * developer never has to set both.
 */
const usingEmulator =
  process.env.USE_EMULATOR === 'true' ||
  Boolean(process.env.DATABASE_EMULATOR_HOST) ||
  Boolean(process.env.FIRESTORE_EMULATOR_HOST) ||
  Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST);

/**
 * The active Google Cloud project id, read from the platform-provided
 * environment. GCLOUD_PROJECT is set by the Firebase CLI during deploy-time
 * trigger discovery and by the Functions runtime; FIREBASE_CONFIG is the
 * canonical runtime carrier. Returns undefined only when nothing is set (e.g. a
 * bare local process with no env), where the emulator fallback then applies.
 */
function resolveProjectId(): string | undefined {
  if (process.env.GCLOUD_PROJECT) {
    return process.env.GCLOUD_PROJECT;
  }
  if (process.env.GCP_PROJECT) {
    return process.env.GCP_PROJECT;
  }
  try {
    const config = process.env.FIREBASE_CONFIG
      ? JSON.parse(process.env.FIREBASE_CONFIG)
      : undefined;
    return typeof config?.projectId === 'string' ? config.projectId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Initialise once and reuse. getApps() guards the hot-reload / repeated-import
 * case (jest, the Functions runtime re-importing modules) so we never throw on a
 * duplicate initializeApp.
 */
/** The storageBucket the platform supplied in FIREBASE_CONFIG, when it supplied
 *  a usable one. Parsed defensively: the variable is absent locally, and a
 *  malformed or bucket-less value must degrade to "no answer" so the caller
 *  falls through to the derived name rather than crashing at import time. */
function configuredStorageBucket(): string | undefined {
  const raw = process.env.FIREBASE_CONFIG;
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as { storageBucket?: unknown };
    return typeof parsed.storageBucket === 'string' &&
      parsed.storageBucket.length > 0
      ? parsed.storageBucket
      : undefined;
  } catch {
    return undefined;
  }
}

function ensureApp(): App {
  const existing = getApps();
  if (existing.length > 0) {
    return existing[0];
  }

  // databaseURL is required for the admin SDK to address the right RTDB instance.
  // Resolution order, most specific first:
  //   1. FIREBASE_DATABASE_URL - explicit override for local seed/admin scripts
  //      (they dotenv-load it themselves; it is a RESERVED key in deployed
  //      Functions, so it is never set there).
  //   2. Derived from the active project id + the fixed REGION. The default RTDB
  //      instance is always `<projectId>-default-rtdb` and the whole app is
  //      pinned to one region, so this is deterministic for dev/prod/any project
  //      with nothing baked into source. projectId comes from the platform
  //      (GCLOUD_PROJECT, or FIREBASE_CONFIG) which is set both at deploy-time
  //      trigger analysis AND at runtime - fixing the deploy-time
  //      "Can't determine Firebase Database URL" crash.
  //   3. A stable emulator namespace (the emulator host var carries the real
  //      address, so any well-formed URL works here).
  const projectId = resolveProjectId();
  const databaseURL =
    process.env.FIREBASE_DATABASE_URL ||
    (projectId
      ? `https://${projectId}-default-rtdb.${REGION}.firebasedatabase.app`
      : undefined) ||
    (usingEmulator
      ? 'https://safentia-tech-default-rtdb.europe-west1.firebasedatabase.app'
      : undefined);

  // The Storage bucket, resolved the same way as databaseURL above - most
  // specific first - because relying on the platform to supply it turned out not
  // to be safe:
  //   1. FIREBASE_STORAGE_BUCKET - the explicit override the scripts set.
  //   2. FIREBASE_CONFIG's own storageBucket, WHEN it carries a non-empty one.
  //   3. Derived from the project id.
  //
  // Step 3 exists because step 2 silently failed in production. FIREBASE_CONFIG
  // came through without a usable bucket, so `storage.bucket()` threw "Bucket
  // name not specified or invalid" at runtime - a 500 with every auth check
  // already passed, which reads like anything but a configuration problem. It
  // took down getReportDownloadUrl, and the same call sits under report
  // generation and action-evidence stamping.
  //
  // The derived form is `<projectId>.firebasestorage.app`: the default for
  // projects created since the Storage domain change. A project still on the
  // older `<projectId>.appspot.com` bucket must set the env var (or carry it in
  // FIREBASE_CONFIG) - which is exactly what steps 1 and 2 are for, so the guess
  // is only ever the last resort.
  const storageBucket =
    process.env.FIREBASE_STORAGE_BUCKET ||
    configuredStorageBucket() ||
    (projectId ? `${projectId}.firebasestorage.app` : undefined);

  // Both keys are spread CONDITIONALLY: passing an explicit `undefined` does NOT
  // fall back to the platform config, it OVERRIDES it with nothing.
  return initializeApp({
    ...(databaseURL ? { databaseURL } : {}),
    ...(storageBucket ? { storageBucket } : {}),
  });
}

const app = ensureApp();

/** Realtime Database handle (admin privilege - bypasses security rules). */
export const db: Database = getDatabase(app);

/** Firebase Auth admin handle - sets custom claims, creates users. */
export const auth: Auth = getAuth(app);

/** Cloud Storage admin handle - used by the report engine and rule-bypassed ops. */
export const storage: Storage = getStorage(app);
