// ============================================================================
// Wordmark - the Safentia mark.
//
// This used to be typeset (an inline SVG glyph beside the product name) because
// no real artwork existed. The supplied logo files replace it, and the reason the
// typeset version gave for avoiding an image is answered rather than ignored: the
// intrinsic dimensions travel with every <img>, so the box is reserved before the
// bytes arrive and the mark cannot shift the layout. The instance in the site
// header additionally asks for high fetch priority so it lands in the first paint.
//
// Two axes decide which file is used:
//   - SHAPE: the horizontal lockup where there is width, the icon alone in square
//     or narrow chrome (`glyphOnly`).
//   - BACKGROUND: the light-background artwork in the light scheme, the
//     dark-background artwork in the dark scheme. We read the resolved scheme from
//     the theme rather than a CSS media query, because a visitor who has pinned a
//     preference must get the matching artwork even when the OS disagrees.
//
// This is the PRODUCT's mark. It is not `theme.logoUrl`, which is the signed-in
// customer organisation's own logo and is rendered separately by ConsoleShell.
// ============================================================================

import { Link } from 'react-router-dom';
import { BRAND_NAME } from '../design/brand';
import { useTheme } from '../design/ThemeProvider';
import styles from './Wordmark.module.css';

/** Intrinsic pixel sizes of the supplied artwork. Passed to the <img> so the
 *  browser can reserve the correct box from the aspect ratio alone. */
const LOCKUP_SIZE = { width: 1707, height: 643 } as const;
const ICON_SIZE = { width: 1038, height: 1200 } as const;

export interface WordmarkProps {
  /** Renders the icon alone, for tight chrome such as a mobile header. */
  glyphOnly?: boolean;
  /** Wraps the mark in a link to the given path. Omit for a non-interactive mark. */
  to?: string;
  /** Overrides the rendered size. */
  size?: 'sm' | 'md' | 'lg';
  /** Marks this instance as the one worth fetching early. Set it on the mark that
   *  sits in the initial viewport (the site header); leave it off elsewhere so
   *  footers and dialogs do not compete with real page content. */
  priority?: boolean;
}

export function Wordmark({
  glyphOnly = false,
  to,
  size = 'md',
  priority = false,
}: WordmarkProps) {
  const { scheme } = useTheme();
  const onDark = scheme === 'dark';

  const src = glyphOnly
    ? onDark
      ? '/logos/logoIconDark.png'
      : '/logos/logoIconLight.png'
    : onDark
      ? '/logos/logoDarkMain.png'
      : '/logos/logoLightMain.png';
  const intrinsic = glyphOnly ? ICON_SIZE : LOCKUP_SIZE;

  const image = (
    <img
      className={`${styles.mark} ${glyphOnly ? styles.icon : styles.lockup} ${styles[size]}`}
      src={src}
      width={intrinsic.width}
      height={intrinsic.height}
      // Inside a link the anchor already carries the accessible name, so the image
      // would only repeat it. Standing alone, it is the name.
      alt={to ? '' : BRAND_NAME}
      decoding="async"
      fetchPriority={priority ? 'high' : 'auto'}
    />
  );

  if (!to) {
    return image;
  }
  return (
    <Link to={to} className={styles.link} aria-label={`${BRAND_NAME} home`}>
      {image}
    </Link>
  );
}
