// ============================================================================
// SpaceMark - the visual identity for one space (a staff organisation or a
// customer portal). ONE definition, shared by the sign-in SpacePicker and the
// in-console OrgSwitcher, so a space looks the same wherever it is chosen.
//
// Three tiers, in order of what the data allows:
//   1. the organisation's logo, where its profile is readable and one is set;
//   2. a monogram of the space's initials on the org's BRAND colour as a FILL,
//      with a readable ink computed for that colour (an arbitrary brand colour
//      has any contrast, so it is never trusted as text);
//   3. a building glyph, for a portal space whose name never resolved past its
//      record id (the security rules only let a token read the customer it
//      names, so a person's other customer spaces fall back to the id).
// ============================================================================

import type { UserSpace } from '../types';
import { readableTextOn } from '../design/tokens/contrast';
import styles from './SpaceMark.module.css';

export type SpaceMarkSize = 'sm' | 'md' | 'lg';

/** Whether a space's name is really just its record id (see the header). The
 *  test is deliberately narrow - unbroken, 16+ characters and containing a
 *  digit - so a real single-word organisation name is never taken for a key. */
export function looksLikeIdentifier(name: string): boolean {
  return /^[-_A-Za-z0-9]{16,}$/.test(name) && /\d/.test(name);
}

/** Up to two initials from the words of a name, for the monogram. */
export function spaceInitials(name: string): string {
  const words = name
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0)
    .slice(0, 2);
  return words.map((word) => word[0]?.toUpperCase() ?? '').join('');
}

const BuildingGlyph = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
    className={styles.glyph}
  >
    <path d="M4 20.5h16" />
    <path d="M6 20.5V6.5l7-3v17" />
    <path d="M13 10.5h5v10" />
    <path d="M9 9.5h1M9 13h1M9 16.5h1M15.5 14h1" />
  </svg>
);

export function SpaceMark({
  space,
  size = 'md',
}: {
  space: UserSpace;
  size?: SpaceMarkSize;
}) {
  const unresolved = looksLikeIdentifier(space.name);
  const className = `${styles.mark} ${styles[size]} ${
    space.logoUrl ? styles.markLogo : ''
  }`;

  // Brand-tinted monogram only when there is no logo and a brand colour exists;
  // otherwise the token default fill carries it. Never a raw brand colour as
  // text - the ink is computed to be readable ON the fill.
  const tint =
    !space.logoUrl && space.brandColor
      ? {
          background: space.brandColor,
          color: readableTextOn(space.brandColor, '#ffffff', '#10141a'),
        }
      : undefined;

  return (
    <span className={className} style={tint} aria-hidden="true">
      {space.logoUrl ? (
        <img className={styles.logo} src={space.logoUrl} alt="" />
      ) : unresolved ? (
        BuildingGlyph
      ) : (
        spaceInitials(space.name)
      )}
    </span>
  );
}
