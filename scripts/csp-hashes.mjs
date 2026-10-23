// ============================================================================
// csp-hashes.mjs - stamp an ENFORCING Content-Security-Policy into every page
// of the pre-rendered build.
//
// Every built page carries inline scripts: the theme bootstrap from index.html,
// plus vite-react-ssg's __staticRouterHydrationData (differs per route) and
// __VITE_REACT_SSG_HASH__ (differs per build). The policy refuses
// 'unsafe-inline' for scripts, so each page must list the sha256 of exactly the
// inline scripts it carries. Those hashes only exist once the build has run, and
// they differ per file, so the policy is injected here as a
// <meta http-equiv="Content-Security-Policy"> - the FIRST child of <head>, so it
// governs everything after it - rather than as a single hosting header.
//
// A meta policy cannot carry frame-ancestors, report-uri/report-to or sandbox,
// so firebase.json still sends `frame-ancestors 'none'` as an HTTP header; the
// browser enforces both policies together.
//
// THIS FILE IS THE ONE PLACE THE POLICY IS DEFINED. Any new third-party origin
// is added to DIRECTIVES below, or the browser blocks it in production. The dev
// server (`vite`) never runs this script and sends no policy at all.
//
// Runs between the pre-render and the sitemap in `npm run build` (package.json).
// It fails the build if a page has inline scripts but no <head>, and it re-reads
// every page afterwards to prove each one carries exactly one policy, first in
// <head>, naming every inline script it executes.
// ============================================================================

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(fileURLToPath(new URL(".", import.meta.url)), "..", "dist");

/**
 * The policy, minus the per-page script hashes (appended to script-src).
 *
 * - Stripe (authed billing only; src/console/billing/stripeClient.ts): Stripe.js
 *   from js.stripe.com and its *.js.stripe.com subdomains, its Elements and 3DS
 *   frames, api.stripe.com XHR, and *.stripe.com images. Stripe's own CSP list.
 * - App Check's reCAPTCHA v3 (src/firebase/index.ts): api.js from
 *   www.google.com/recaptcha/ loads its release from www.gstatic.com/recaptcha/
 *   and runs in a www.google.com or recaptcha.google.com frame. The token
 *   exchange goes to content-firebaseappcheck.googleapis.com.
 * - Google sign-in via signInWithPopup (src/auth/AuthProvider.tsx): the Auth SDK
 *   loads apis.google.com/js/api.js, which frames the auth handler on the
 *   authDomain (safentia-tech.firebaseapp.com, src/config/env.ts).
 * - Firebase Auth / App Check / Storage REST: *.googleapis.com (identitytoolkit,
 *   securetoken, content-firebaseappcheck, firebasestorage). Stored files are
 *   rendered as <img> from firebasestorage.googleapis.com.
 * - RTDB (europe-west1 instance, src/config/env.ts): WebSocket first, over
 *   wss://. Its long-poll fallback - used FIRST whenever localStorage is
 *   unavailable, then upgraded - is JSONP: <script> tags from the database host,
 *   which the server may hand off to another host in the same region. Hence the
 *   regional wildcard in script-src, deliberately narrower than connect-src.
 *   *.firebaseio.com stays in connect-src as the SDK's legacy host.
 * - Callables are deployed to europe-west1 only (functions/src/lib/region.ts),
 *   so the one cloudfunctions.net origin is listed rather than a wildcard.
 * - Mapbox GL v3 (src/console/ui/LocationPicker.tsx): styles, tiles, glyphs and
 *   geocoding from api.mapbox.com (*.tiles.mapbox.com for older tile URLs),
 *   telemetry to events.mapbox.com, and its worker built from a blob: URL
 *   (worker-src, with child-src for browsers that predate worker-src). v3 needs
 *   no 'unsafe-eval'.
 * - style-src keeps 'unsafe-inline': React style props and Mapbox's injected
 *   styles. Scripts never get it, nor 'unsafe-eval'.
 */
const DIRECTIVES = {
  "default-src": ["'self'"],
  "script-src": [
    "'self'",
    "https://js.stripe.com",
    "https://*.js.stripe.com",
    "https://www.google.com/recaptcha/",
    "https://www.gstatic.com/recaptcha/",
    "https://apis.google.com",
    "https://*.europe-west1.firebasedatabase.app",
  ],
  "frame-src": [
    "https://js.stripe.com",
    "https://*.js.stripe.com",
    "https://hooks.stripe.com",
    "https://www.google.com/recaptcha/",
    "https://recaptcha.google.com/recaptcha/",
    "https://safentia-tech.firebaseapp.com",
  ],
  "connect-src": [
    "'self'",
    "https://*.googleapis.com",
    "https://*.firebasedatabase.app",
    "wss://*.firebasedatabase.app",
    "https://*.firebaseio.com",
    "wss://*.firebaseio.com",
    "https://europe-west1-safentia-tech.cloudfunctions.net",
    "https://api.stripe.com",
    "https://api.mapbox.com",
    "https://*.tiles.mapbox.com",
    "https://events.mapbox.com",
  ],
  "img-src": [
    "'self'",
    "data:",
    "blob:",
    "https://firebasestorage.googleapis.com",
    "https://*.stripe.com",
    "https://api.mapbox.com",
  ],
  "style-src": ["'self'", "'unsafe-inline'"],
  "font-src": ["'self'"],
  "worker-src": ["'self'", "blob:"],
  "child-src": ["'self'", "blob:"],
  "object-src": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'self'"],
};

/** The full policy for a page whose inline scripts hash to `hashes`. */
function buildPolicy(hashes) {
  return Object.entries(DIRECTIVES)
    .map(([name, sources]) =>
      [name, ...sources, ...(name === "script-src" ? hashes : [])].join(" "),
    )
    .join("; ");
}

/**
 * The CSP source for one inline script. Browsers hash the script's text as
 * parsed, and the HTML parser folds CR LF / lone CR to LF first, so we do too.
 */
function scriptHash(text) {
  const digest = createHash("sha256")
    .update(text.replace(/\r\n?/g, "\n"), "utf8")
    .digest("base64");
  return `'sha256-${digest}'`;
}

/** Script types the browser executes; anything else (ld+json) is a data block. */
const EXECUTABLE_TYPES = new Set(["", "module", "text/javascript", "application/javascript"]);

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const HEAD_RE = /<head(?:\s[^>]*)?>/i;
const META_RE = /<meta\s+http-equiv="Content-Security-Policy"[^>]*>/gi;

/** The text of every inline, executable script in the page, in order. */
function inlineScripts(html) {
  const out = [];
  for (const [, attrs, body] of html.matchAll(SCRIPT_RE)) {
    if (/\ssrc\s*=/i.test(` ${attrs}`)) {
      continue;
    }
    const type = /\stype\s*=\s*["']?([^"'\s>]*)/i.exec(` ${attrs}`)?.[1] ?? "";
    if (EXECUTABLE_TYPES.has(type.toLowerCase())) {
      out.push(body);
    }
  }
  return out;
}

/** Recursively collect every .html file under dir. */
function htmlFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...htmlFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".html")) {
      out.push(full);
    }
  }
  return out;
}

/** Inject the page's policy as the first child of <head>. Returns the new HTML. */
function stamp(html, file) {
  // A re-run replaces the previous stamp rather than stacking a second policy.
  const clean = html.replace(META_RE, "");
  const head = HEAD_RE.exec(clean);
  if (!head) {
    throw new Error(`${file}: no <head> to carry the Content-Security-Policy`);
  }
  const hashes = [...new Set(inlineScripts(clean).map(scriptHash))];
  const meta = `<meta http-equiv="Content-Security-Policy" content="${buildPolicy(hashes)}">`;
  const at = head.index + head[0].length;
  return clean.slice(0, at) + meta + clean.slice(at);
}

/** Prove the stamped page carries one policy, first in <head>, naming every inline script. */
function verify(html, file) {
  const metas = html.match(META_RE) ?? [];
  if (metas.length !== 1) {
    throw new Error(`${file}: expected 1 CSP meta, found ${metas.length}`);
  }
  const head = HEAD_RE.exec(html);
  if (!head || !html.startsWith(metas[0], head.index + head[0].length)) {
    throw new Error(`${file}: the CSP meta is not the first child of <head>`);
  }
  const policy = /content="([^"]*)"/.exec(metas[0])[1];
  const scriptSrc = policy.split("; ").find((d) => d.startsWith("script-src ")).split(" ");
  for (const hash of inlineScripts(html).map(scriptHash)) {
    if (!scriptSrc.includes(hash)) {
      throw new Error(`${file}: inline script ${hash} is missing from script-src`);
    }
  }
}

function main() {
  const files = htmlFiles(DIST);
  if (files.length === 0) {
    throw new Error(`no .html files under ${DIST} - run the pre-render first`);
  }
  for (const file of files) {
    const name = relative(DIST, file);
    const stamped = stamp(readFileSync(file, "utf8"), name);
    writeFileSync(file, stamped);
    verify(readFileSync(file, "utf8"), name);
  }
  console.log(`csp-hashes: stamped and verified ${files.length} page(s)`);
}

try {
  main();
} catch (error) {
  console.error(`csp-hashes: ${error.message}`);
  process.exit(1);
}
