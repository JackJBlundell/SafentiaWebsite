// ============================================================================
// Vite build configuration (story 2001 / 2075).
//
// Why Vite and not Create React App: the public marketing pages must return
// meaningful HTML to a crawler with no JavaScript executed (story 2075 AC1).
// CRA cannot pre-render, and react-scripts is unmaintained. `vite-react-ssg`
// walks the route table at build time and emits one real HTML file per public
// route, while the signed-in console at /app/** stays a single-page app served
// from its own pre-rendered shell (see firebase.json rewrites).
//
// There are deliberately NO external hosts anywhere in the marketing pages: the
// typeface is self-hosted via @fontsource-variable/inter rather than fetched
// from the Google Fonts CDN, because the Agreement makes the Client the data
// controller for personal data (clause 11.2) and a font CDN request discloses
// visitor IP addresses to a third party we have not listed as a sub-processor
// (clause 11.4). The ONE exception is Stripe, a listed sub-processor for the
// billing feature: the AUTHED billing surface (and only it) loads Stripe.js
// from js.stripe.com via dynamic import (src/console/billing/stripeClient.ts).
// No marketing page loads anything third-party. The signed-in console also
// reaches Firebase, App Check's reCAPTCHA, Google sign-in and Mapbox.
//
// Every origin the site may load is listed in ONE place: the enforcing
// Content-Security-Policy that scripts/csp-hashes.mjs stamps into each built
// page after the pre-render, alongside the sha256 of that page's inline
// scripts. A new external host is blocked in production until it is added
// there. The dev server sends no policy.
// ============================================================================

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // Source maps are generated so a production stack trace can be decoded
    // during the warranty period (Agreement clause 12.2), but 'hidden' omits the
    // sourceMappingURL comment, so shipped bundles do not point browsers at the
    // original source. Hosting also refuses to serve **/*.map (firebase.json).
    sourcemap: 'hidden',
    outDir: 'dist',
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // Only the web app's own tests. The Cloud Functions project under
    // functions/ has its own jest suite; sweeping it up here runs jest-API
    // tests under vitest and fails them all.
    include: ['src/**/*.test.{ts,tsx}'],
    // Vitest's 5s default is calibrated for a unit test, not for an interaction
    // test that drives real keystrokes through jsdom and re-renders a console
    // screen on each one. Vitest runs a worker per core, so what a test costs in
    // the full suite is mostly contention rather than its own work: the invite
    // form's three-field cases and the validation flag basket run in about a
    // second alone and over five in a 33-file run, which is exactly why they
    // failed in CI and passed when run on their own. A genuine hang still fails
    // - it just takes twenty seconds to say so, which is the right trade when
    // the alternative is a suite that is red on a busy runner and green locally.
    testTimeout: 20_000,
  },
});
