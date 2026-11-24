// ============================================================================
// generate-sitemap.mjs - emit dist/sitemap.xml after the pre-render build.
//
// The sitemap is derived from what the build ACTUALLY produced (the .html files
// in dist/), not from a hand-kept list, so a new pre-rendered page - including
// each published news article - enters the sitemap with no further wiring, and
// a page that stops being built silently leaves it.
//
// Excluded: the console shell (/app), the auth pages (/login,
// /forgot-password) and any not-found page. Those are all noindex surfaces; a
// sitemap that lists pages robots.txt disallows sends crawlers contradictory
// signals.
//
// Runs as the second half of `npm run build` (package.json).
// ============================================================================

import { readdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SITE_ORIGIN = "https://safentia.co.uk";
const DIST = join(fileURLToPath(new URL(".", import.meta.url)), "..", "dist");

/** Route prefixes that must never appear in the sitemap (all noindex). */
const EXCLUDED_ROUTES = ["/app", "/login", "/signup", "/forgot-password", "/404"];

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

/**
 * Map a built HTML file to its canonical route under Hosting's cleanUrls:
 * `.html` is stripped, and an `index.html` (at any depth) serves its directory.
 */
function routeFor(file) {
  const rel = relative(DIST, file).split(sep).join("/");
  if (rel === "index.html") {
    return "/";
  }
  const withoutExt = rel.replace(/\.html$/, "");
  if (withoutExt.endsWith("/index")) {
    return `/${withoutExt.slice(0, -"/index".length)}`;
  }
  return `/${withoutExt}`;
}

function isExcluded(route) {
  return EXCLUDED_ROUTES.some(
    (prefix) => route === prefix || route.startsWith(`${prefix}/`)
  );
}

const routes = htmlFiles(DIST)
  .map(routeFor)
  .filter((route) => !isExcluded(route))
  .sort();

if (routes.length === 0) {
  // A sitemap with no URLs means the build produced nothing indexable, which is
  // never intended: fail loudly rather than deploy an empty sitemap.
  console.error("generate-sitemap: no indexable pages found in dist/");
  process.exit(1);
}

// lastmod is the build date: content only changes when the site is rebuilt,
// because every page (news included) is repository content.
const lastmod = new Date().toISOString().slice(0, 10);

const xml = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...routes.map((route) =>
    [
      "  <url>",
      `    <loc>${SITE_ORIGIN}${route === "/" ? "" : route}</loc>`,
      `    <lastmod>${lastmod}</lastmod>`,
      "  </url>",
    ].join("\n")
  ),
  "</urlset>",
  "",
].join("\n");

writeFileSync(join(DIST, "sitemap.xml"), xml);
console.log(
  `generate-sitemap: wrote ${routes.length} URLs to dist/sitemap.xml`
);
