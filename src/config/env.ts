// ============================================================================
// Web runtime configuration (stories 2001 / 2004).
//
// Unlike the mobile app - where @react-native-firebase reads native config files
// and there are no Firebase keys in JavaScript - a web app MUST carry its Firebase
// config in the bundle. This is expected and safe: these identifiers are public by
// design, and the real access boundary is the security rules plus App Check
// attestation, never the secrecy of an API key.
//
// The one value that is NOT hard-coded is the reCAPTCHA v3 site key used by App
// Check. It is created in the Firebase console (App Check > Apps > Web) and read
// from an environment variable, so a fork or a preview deployment can point at a
// different key without a code change. `hasUnfilledConfig()` makes a missing slot
// loud rather than silent.
// ============================================================================

import type { Environment } from "../types";

/** Which Firebase project this build points at. Distinct from the per-user
 *  live/test data root, which comes from the signed-in user's `testMode` claim
 *  and never from the build (brief 4.7 / 4.8). */
export type FirebaseProjectFlavour = "dev" | "prod";

/**
 * Firebase Web SDK configuration for `safentia-tech`, as reported by
 * `firebase apps:sdkconfig WEB --project safentia-tech`.
 *
 * The databaseURL is stated explicitly because the RTDB instance lives in
 * europe-west1; omitting it makes `getDatabase()` resolve the wrong (US) default.
 */
export const firebaseConfig = {
  apiKey: "AIzaSyBHWkM_uRNSKDQQM8ciSPzAJp6_qCpe-gM",
  authDomain: "safentia-tech.firebaseapp.com",
  databaseURL:
    "https://safentia-tech-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "safentia-tech",
  storageBucket: "safentia-tech.firebasestorage.app",
  messagingSenderId: "603824171088",
  appId: "1:603824171088:web:c14f679f34cd09fb444955",
} as const;

export interface WebConfig {
  flavour: FirebaseProjectFlavour;
  /** Public origin, used for canonical URLs, the sitemap and structured data. */
  siteUrl: string;
  /** The product name, matching the app's BRAND_NAME. */
  brandName: string;
  /**
   * reCAPTCHA v3 site key for App Check (story 2004). Public by design. Set
   * `VITE_RECAPTCHA_V3_SITE_KEY` at build time; see SETUP.md. Empty means App
   * Check is not configured, which is tolerated in development (a debug token is
   * used instead) and reported loudly in production.
   */
  recaptchaV3SiteKey: string;
  /** Region every callable is deployed to (functions/src/lib/region.ts). */
  functionsRegion: string;
  /** Public Mapbox token (same one the app ships) for address search in the
   *  console's site and building forms. Public by design, like the app's. */
  mapboxAccessToken: string;
  /** Safe fallback data root used only before a claim resolves. Real routing
   *  always comes from the user's `testMode` claim. */
  fallbackEnvironment: Environment;
}

export const webConfig: WebConfig = {
  flavour: import.meta.env.PROD ? "prod" : "dev",
  siteUrl: "https://safentia.co.uk",
  brandName: "Safentia",
  recaptchaV3SiteKey: import.meta.env.VITE_RECAPTCHA_V3_SITE_KEY ?? "",
  functionsRegion: "europe-west1",
  mapboxAccessToken:
    "pk.eyJ1Ijoic2FmZW50aWEiLCJhIjoiY21yM29iZWFpMDMycDJ6cXJnMXFheTVidiJ9.8UIrzgb3Lwm99rDNRmyJ0A",
  fallbackEnvironment: "live",
};

/** True when a required slot has not been filled. Surfaced at startup so an
 *  unconfigured production deployment is loud, never silent. */
export function hasUnfilledConfig(): boolean {
  return webConfig.recaptchaV3SiteKey.trim() === "";
}

/** True when we are rendering at build time (pre-render) rather than in a
 *  browser. Nothing that touches `window`, Firebase or `localStorage` may run in
 *  this pass, or the public pages fail to build. */
export const isPrerender = typeof window === "undefined";
