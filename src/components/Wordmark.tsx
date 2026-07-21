// ============================================================================
// Wordmark - the Safentia mark, rendered as type plus an inline SVG glyph.
//
// Deliberately not an image file (matching the app's brand.ts reasoning): an SVG
// drawn in the document paints on the first frame, scales to any size without a
// second asset, inherits the theme's colours, and costs no network request and no
// layout shift. A logo that arrives late is the most visible jank on a page.
//
// The glyph is a flame inside a rounded square. It uses the BRAND accent, never a
// RAG colour: red, amber and green are a fixed safety language in this product
// and must not be spent on decoration (tokens.css header).
// ============================================================================

import { Link } from 'react-router-dom';
import { BRAND_NAME } from '../design/brand';
import styles from './Wordmark.module.css';

export interface WordmarkProps {
  /** Renders the mark without the word, for tight chrome such as a mobile header. */
  glyphOnly?: boolean;
  /** Wraps the mark in a link to the given path. Omit for a non-interactive mark. */
  to?: string;
  /** Overrides the rendered size. The glyph and type scale together. */
  size?: 'sm' | 'md' | 'lg';
}

export function Wordmark({ glyphOnly = false, to, size = 'md' }: WordmarkProps) {
  const content = (
    <span className={`${styles.root} ${styles[size]}`}>
      <svg
        className={styles.glyph}
        viewBox="0 0 24 24"
        // The glyph is decorative when the word is beside it (the word is already
        // read out); when it stands alone it carries the accessible name.
        role={glyphOnly ? 'img' : undefined}
        aria-hidden={glyphOnly ? undefined : true}
        aria-label={glyphOnly ? BRAND_NAME : undefined}
        focusable="false"
      >
        <rect width="24" height="24" rx="6.5" className={styles.glyphPlate} />
        <path
          d="M12 4.4c0 2.3-1 4.3-2.1 5.2-.9-.5-1.3-1.4-1.3-2.3-1 1-1.8 2.4-1.8 4.1a5.2 5.2 0 0 0 10.4 0c0-3.8-3.5-6-5.2-7z"
          className={styles.glyphFlame}
        />
      </svg>
      {!glyphOnly && <span className={styles.word}>{BRAND_NAME}</span>}
    </span>
  );

  if (!to) {
    return content;
  }
  return (
    <Link to={to} className={styles.link} aria-label={`${BRAND_NAME} home`}>
      {content}
    </Link>
  );
}
