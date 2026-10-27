// ============================================================================
// Typed accessors for the Firebase Web SDK - the web twin of FireRite/src/firebase.
//
// The app imports @react-native-firebase and reads native config files; the web
// imports the modular `firebase` package and passes config explicitly. Everything
// downstream (AuthProvider, the RTDB query bridge, callables) depends only on the
// shape exported here, so the two platforms stay symmetrical even though the SDKs
// differ. Nothing else in the web app imports from `firebase/*` directly.
//
// IMPORTANT: this module must never be imported during the pre-render pass. The
// SDK reaches for browser globals on initialisation, and a public marketing page
// has no business touching Firebase at build time. Public pages import nothing
// from here; the console entry point does.
// ============================================================================

import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  connectAuthEmulator,
  type Auth,
} from 'firebase/auth';
import {
  getDatabase,
  connectDatabaseEmulator,
  type Database,
} from 'firebase/database';
import {
  getStorage,
  connectStorageEmulator,
  type FirebaseStorage,
} from 'firebase/storage';
import {
  getFunctions,
  connectFunctionsEmulator,
  type Functions,
} from 'firebase/functions';
import {
  getToken as getAppCheckToken,
  initializeAppCheck,
  onTokenChanged as onAppCheckTokenChanged,
  ReCaptchaV3Provider,
  type AppCheck,
} from 'firebase/app-check';
import { firebaseConfig, hasUnfilledConfig, isPrerender, webConfig } from '../config/env';

/** Local emulator wiring, opt-in via VITE_USE_EMULATOR so no production build can
 *  reach an emulator and no caller hard-codes a host. Mirrors the app's EMULATOR
 *  block and the ports declared in firebase.json. */
const EMULATOR = {
  enabled: import.meta.env.VITE_USE_EMULATOR === 'true',
  host: '127.0.0.1',
  ports: { auth: 9099, database: 9000, storage: 9199, functions: 5001 },
} as const;

let appCheckInstance: AppCheck | undefined;
let started = false;

// ----------------------------------------------------------------------------
// App Check health, for the "security check blocked" notice.
//
// App Check on the web runs on reCAPTCHA. A browser that blocks it (an ad
// blocker, a privacy browser, a locked-down work network) or that reCAPTCHA
// scores as a bot gets no valid token, and every service that enforces App
// Check then refuses it - which looks like a page loading forever. Probing for
// a token once at start-up lets the console SAY so instead.
//
// 'blocked' is only reported while the browser is online: offline, every call
// fails for a reason the console already handles, and blaming the security
// check would send the user chasing the wrong fix.
// ----------------------------------------------------------------------------

export type AppCheckStatus = 'checking' | 'ok' | 'blocked';

let appCheckStatus: AppCheckStatus = 'checking';
const appCheckListeners = new Set<() => void>();

function setAppCheckStatus(next: AppCheckStatus): void {
  if (next === appCheckStatus) {
    return;
  }
  appCheckStatus = next;
  appCheckListeners.forEach((listener) => listener());
}

export function getAppCheckStatus(): AppCheckStatus {
  return appCheckStatus;
}

export function subscribeAppCheckStatus(listener: () => void): () => void {
  appCheckListeners.add(listener);
  return () => {
    appCheckListeners.delete(listener);
  };
}

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/** Ask for a token and record whether one could be had. */
function probeAppCheck(instance: AppCheck): void {
  getAppCheckToken(instance, false)
    .then(() => setAppCheckStatus('ok'))
    .catch((error: unknown) => {
      if (isOffline()) {
        // Try again once the connection is back, rather than blaming the check.
        window.addEventListener('online', () => probeAppCheck(instance), { once: true });
        return;
      }
      console.error('[Safentia] App Check token unavailable', error);
      setAppCheckStatus('blocked');
    });
}

function app(): FirebaseApp {
  return getApps().length ? getApp() : initializeApp(firebaseConfig);
}

/**
 * Initialise App Check before any guarded backend call (story 2004, Agreement
 * clause 3.1 "attestation preventing unauthorised clients").
 *
 * In development we register a debug token, which App Check exchanges for a real
 * token once the token is allow-listed in the console. In production a missing
 * site key is a configuration fault: we report it loudly and skip initialisation
 * rather than crash the whole site, because an unattested read still fails
 * closed at the rules layer. Failing the render as well would turn a
 * misconfiguration into an outage.
 */
function initAppCheck(): void {
  if (appCheckInstance || isPrerender) {
    return;
  }
  if (import.meta.env.DEV) {
    const debugToken = import.meta.env.VITE_APPCHECK_DEBUG_TOKEN;
    // The SDK reads this global; `true` prints a fresh token to the console for
    // one-off registration, a string reuses an already-registered token.
    (
      globalThis as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: string | boolean }
    ).FIREBASE_APPCHECK_DEBUG_TOKEN = debugToken ? debugToken : true;
  }
  if (hasUnfilledConfig()) {
    // Loud in every environment, but fatal in none. See SETUP.md.
    console.error(
      '[Safentia] VITE_RECAPTCHA_V3_SITE_KEY is not set, so App Check is not initialised. ' +
        'Backend calls will be rejected wherever App Check enforcement is switched on.',
    );
    return;
  }
  const instance = initializeAppCheck(app(), {
    provider: new ReCaptchaV3Provider(webConfig.recaptchaV3SiteKey),
    // Refresh automatically so a long console session never drops below an
    // attested state mid-edit.
    isTokenAutoRefreshEnabled: true,
  });
  appCheckInstance = instance;
  // A token arriving later (the blocker was switched off, a retry succeeded)
  // clears the notice on its own.
  onAppCheckTokenChanged(
    instance,
    () => setAppCheckStatus('ok'),
    () => undefined,
  );
  probeAppCheck(instance);
}

function wireEmulators(): void {
  if (!EMULATOR.enabled) {
    return;
  }
  connectAuthEmulator(firebase.auth(), `http://${EMULATOR.host}:${EMULATOR.ports.auth}`, {
    disableWarnings: true,
  });
  connectDatabaseEmulator(firebase.db(), EMULATOR.host, EMULATOR.ports.database);
  connectStorageEmulator(firebase.storage(), EMULATOR.host, EMULATOR.ports.storage);
  connectFunctionsEmulator(firebase.functions(), EMULATOR.host, EMULATOR.ports.functions);
}

/** The single import surface for Firebase services across the web app. */
export const firebase = {
  auth: (): Auth => getAuth(app()),
  db: (): Database => getDatabase(app(), firebaseConfig.databaseURL),
  storage: (): FirebaseStorage => getStorage(app()),
  /** Callables are deployed to one region (functions/src/lib/region.ts); the
   *  client must name it or it calls us-central1 and 404s. */
  functions: (): Functions => getFunctions(app(), webConfig.functionsRegion),
  appCheck: (): AppCheck => {
    if (!appCheckInstance) {
      throw new Error('App Check not initialised - call startFirebase() first.');
    }
    return appCheckInstance;
  },
} as const;

/**
 * One-time bootstrap: App Check first (so the first guarded call is already
 * attested), then emulator wiring for local development. Idempotent, and a no-op
 * during the pre-render pass.
 */
export function startFirebase(): void {
  if (started || isPrerender) {
    return;
  }
  started = true;
  initAppCheck();
  wireEmulators();
}
