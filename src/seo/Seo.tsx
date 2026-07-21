// ============================================================================
// Seo - per-page document head (story 2075).
//
// `Head` from vite-react-ssg writes these tags into the PRE-RENDERED HTML at build
// time, so a crawler that executes no JavaScript still receives a correct title,
// description, canonical URL and structured data. That is the whole point of the
// pre-render pass; a client-side-only head would leave every page sharing the
// index.html title.
//
// Rules encoded here rather than left to each page:
//   - Exactly one canonical URL per page, absolute, no trailing slash.
//   - The console and any non-public route is `noindex`, so signed-in surfaces
//     never enter the index (story 2075 AC3).
//   - Open Graph and Twitter cards are derived from the same title/description,
//     so they cannot drift from what the page actually says.
// ============================================================================

import type { ReactNode } from 'react';
import { Head } from 'vite-react-ssg';
import { BRAND_NAME, BRAND_TAGLINE } from '../design/brand';
import { webConfig } from '../config/env';

export interface SeoProps {
  /** The page title, WITHOUT the brand suffix, which is appended here. Pass an
   *  empty string on the home page, whose title is the brand and its tagline. */
  title?: string;
  description: string;
  /** Path beginning with a slash, e.g. "/how-it-works". The canonical is built
   *  from the configured site origin so it is always absolute. */
  path: string;
  /** Keeps the page out of search indexes. Every signed-in route passes this. */
  noIndex?: boolean;
  /** JSON-LD structured data. Serialised into a script tag verbatim. */
  structuredData?: Record<string, unknown> | Array<Record<string, unknown>>;
  /** Overrides the `article` Open Graph type used by news posts. */
  ogType?: 'website' | 'article';
  children?: ReactNode;
}

/** Build an absolute, trailing-slash-free canonical URL. */
export function canonicalUrl(path: string): string {
  const origin = webConfig.siteUrl.replace(/\/$/, '');
  if (path === '/' || path === '') {
    return origin;
  }
  return `${origin}/${path.replace(/^\//, '').replace(/\/$/, '')}`;
}

export function Seo({
  title,
  description,
  path,
  noIndex = false,
  structuredData,
  ogType = 'website',
  children,
}: SeoProps) {
  const fullTitle = title ? `${title} | ${BRAND_NAME}` : `${BRAND_NAME} - ${BRAND_TAGLINE}`;
  const url = canonicalUrl(path);

  return (
    <Head>
      <title>{fullTitle}</title>
      <meta name="description" content={description} />
      {/* A canonical URL asserts "this is the indexable address of this page";
          on a noindex page that assertion is a contradiction, so none is set. */}
      {!noIndex && <link rel="canonical" href={url} />}

      {noIndex ? (
        <meta name="robots" content="noindex, nofollow" />
      ) : (
        <meta name="robots" content="index, follow, max-image-preview:large" />
      )}

      <meta property="og:site_name" content={BRAND_NAME} />
      <meta property="og:type" content={ogType} />
      <meta property="og:title" content={fullTitle} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={url} />
      <meta property="og:locale" content="en_GB" />

      {/* No image is declared: the site ships no raster art, and pointing a card
          at a logo we do not have would render a broken preview. A card without
          an image degrades to a clean text card. */}
      <meta name="twitter:card" content="summary" />
      <meta name="twitter:title" content={fullTitle} />
      <meta name="twitter:description" content={description} />

      {structuredData && (
        <script type="application/ld+json">
          {JSON.stringify(structuredData)}
        </script>
      )}
      {children}
    </Head>
  );
}

/** The Organization node, included once on the home page. Kept here so the
 *  company facts have exactly one definition across the whole site. */
export function organisationStructuredData(): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: BRAND_NAME,
    url: canonicalUrl('/'),
    description: BRAND_TAGLINE,
  };
}

/** The SoftwareApplication node, describing the product itself. */
export function productStructuredData(description: string): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: BRAND_NAME,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'iOS, Android, Web',
    url: canonicalUrl('/'),
    description,
  };
}
