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
// There are deliberately NO external hosts anywhere in the built output: the
// typeface is self-hosted via @fontsource-variable/inter rather than fetched
// from the Google Fonts CDN, because the Agreement makes the Client the data
// controller for personal data (clause 11.2) and a font CDN request discloses
// visitor IP addresses to a third party we have not listed as a sub-processor
// (clause 11.4).
// ============================================================================

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // Source maps ship so a production stack trace is readable during the
    // warranty period (Agreement clause 12.2) without a separate upload step.
    sourcemap: true,
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
  },
});
