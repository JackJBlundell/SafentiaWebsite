// ============================================================================
// ProductShot - a real screenshot of the product, served the way this site
// serves images: WebP with a PNG fallback, intrinsically sized, decorative.
//
// The site's rule is that product visuals are drawn in CSS and inline SVG - a
// hand-drawn mock never goes stale and weighs nothing (see PhoneFrame). The
// exceptions are the places where a visitor is deciding whether this is REAL
// software, and an actual screen answers that in a way an illustration cannot:
// the hero (AppScreenshot) and the two "closer look" rows this component serves.
//
// Every exception pays the same price to be one:
//   - WebP at roughly twice the rendered width, with the PNG fallback cut to the
//     same size. The masters stay in the repo to re-cut from, but a 3.4MB
//     capture never reaches a visitor.
//   - Intrinsic width/height, so the browser reserves the box before the bytes
//     arrive and the row never shifts as it loads.
//   - Self-hosted. No third-party origin gets to see a visitor's IP.
//   - DECORATIVE: alt="" and aria-hidden. The heading and copy beside each one
//     already say what the screen is; "screenshot of the flag editor" would add
//     noise, not information.
//
// Below the fold, so lazy - unlike the hero, which is eager and high priority.
// ============================================================================

import styles from './ProductShot.module.css';

export interface ProductShotProps {
  /** Base name under /images, without extension or @2x suffix. */
  name: string;
  /** Intrinsic size of the SERVED asset (not the master), for the box reserve. */
  width: number;
  height: number;
  /** Rendered width in CSS pixels, so the browser can choose before layout. */
  sizes: string;
  className?: string;
}

export function ProductShot({
  name,
  width,
  height,
  sizes,
  className = '',
}: ProductShotProps) {
  return (
    <picture className={`${styles.wrap} ${className}`} aria-hidden="true">
      <source srcSet={`/images/${name}.webp`} type="image/webp" />
      <img
        className={styles.shot}
        src={`/images/${name}@2x.png`}
        alt=""
        width={width}
        height={height}
        loading="lazy"
        decoding="async"
        sizes={sizes}
      />
    </picture>
  );
}
