// ============================================================================
// AppScreenshot - a real screenshot of the field app for the home hero.
//
// Every other product visual on this site is drawn in CSS and inline SVG (see
// PhoneFrame): a hand-drawn mock never goes stale, weighs nothing and cannot
// promise a screen that does not exist. That reasoning still holds for the
// depictions further down the page. The HERO is the deliberate exception - it is
// where a visitor decides whether this is real software, and an actual screen
// answers that in a way an illustration cannot.
//
// NO PhoneFrame around it. The capture is a mockup that already includes the
// device, so wrapping it in the CSS bezel drew a phone around a phone. This
// stands alone and brings its own drop shadow instead.
//
// SERVED AS WEBP with a PNG fallback, at roughly twice the rendered width. The
// source capture is 1419x2796 and 1.1MB - a quarter of a second of a visitor's
// first impression spent on an image displayed at a fraction of that size. The
// <picture> gives modern browsers 56KB and everything else a resized PNG; the
// original stays in the repo as the master to re-cut from.
//
// DECORATIVE, so `alt=""` and aria-hidden. The heading and copy beside it
// already say what the app is and what it does; announcing "screenshot of a job
// page" would add noise, not information.
// ============================================================================

import styles from './AppScreenshot.module.css';

export interface AppScreenshotProps {
  className?: string;
  /** Rendered width in CSS pixels, so the browser can pick a candidate before
   *  layout. The caller sizes the element; this only tells the browser which
   *  candidate to fetch, so it should match the widest rendered case. */
  width?: number;
}

/** Intrinsic size of the served asset, so the browser reserves the right box
 *  before the bytes arrive and the hero never shifts as it loads. */
const ASSET = { width: 700, height: 1379 } as const;

export function AppScreenshot({
  className = '',
  width = 440,
}: AppScreenshotProps) {
  return (
    <picture className={`${styles.wrap} ${className}`} aria-hidden="true">
      <source srcSet="/images/app_job_page.webp" type="image/webp" />
      <img
        className={styles.shot}
        src="/images/app_job_page@2x.png"
        alt=""
        width={ASSET.width}
        height={ASSET.height}
        // Above the fold: it must NOT be lazy-loaded, and it is worth fetching
        // ahead of the rest of the page's imagery.
        loading="eager"
        fetchPriority="high"
        decoding="async"
        sizes={`${width}px`}
      />
    </picture>
  );
}
