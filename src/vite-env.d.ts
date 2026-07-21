/// <reference types="vite/client" />

// The only build-time variable the web app reads. Declared so a typo in the
// name is a compile error rather than a silent `undefined` at runtime.
interface ImportMetaEnv {
  readonly VITE_RECAPTCHA_V3_SITE_KEY?: string;
  /** Set to "true" to point the web app at the local Firebase emulators. */
  readonly VITE_USE_EMULATOR?: string;
  /** App Check debug token for local development (see SETUP.md). */
  readonly VITE_APPCHECK_DEBUG_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
