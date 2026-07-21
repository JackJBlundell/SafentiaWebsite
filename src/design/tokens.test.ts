// ============================================================================
// tokens.test.ts - pins tokens.css to tokens/palette.ts.
//
// The colour values exist twice on purpose (see the header of tokens.css: the
// pre-rendered pages must paint before JavaScript runs). Duplication without a
// gate is drift, so this test parses the stylesheet and asserts every value it
// declares matches the palette module character for character.
//
// It also re-verifies the RAG and status colours clear WCAG AA against the
// surfaces they are placed on, in BOTH modes. A safety colour that quietly falls
// below AA is a defect in a product where colour carries risk meaning, so it
// fails the build rather than a design review.
// ============================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio, AA_NORMAL, AA_LARGE } from './tokens/contrast';
import { DEFAULT_BRAND, NEUTRALS, RAG, STATUS } from './tokens/palette';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, 'tokens.css'), 'utf8');

/** Read a custom property out of a specific selector block. */
function readVar(block: string, name: string): string {
  const match = block.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  if (!match || !match[1]) {
    throw new Error(`Custom property ${name} not found in the given block.`);
  }
  return match[1].trim().toLowerCase();
}

/** The `:root { ... }` block (the light defaults). */
function rootBlock(): string {
  const match = css.match(/:root\s*\{([\s\S]*?)\n\}/);
  if (!match || !match[1]) {
    throw new Error('Could not locate the :root block in tokens.css');
  }
  return match[1];
}

/** The explicit `:root[data-theme='dark'] { ... }` block. */
function darkBlock(): string {
  const match = css.match(/:root\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/);
  if (!match || !match[1]) {
    throw new Error('Could not locate the dark theme block in tokens.css');
  }
  return match[1];
}

/** The dark block nested inside the prefers-color-scheme media query. Parsed by
 *  locating the selector and then reading to its closing brace, rather than by
 *  matching a fixed indentation, so reformatting the stylesheet cannot silently
 *  disable this test. */
function darkMediaBlock(): string {
  const start = css.search(/@media \(prefers-color-scheme: dark\)/);
  if (start === -1) {
    throw new Error('Could not locate the prefers-color-scheme media query.');
  }
  const match = css
    .slice(start)
    .match(/:root:not\(\[data-theme='light'\]\)\s*\{([\s\S]*?)\n\s*\}/);
  if (!match || !match[1]) {
    throw new Error('Could not locate the prefers-color-scheme dark block.');
  }
  return match[1];
}

describe('tokens.css mirrors tokens/palette.ts', () => {
  const light = rootBlock();
  const dark = darkBlock();

  const neutralPairs: Array<[string, keyof typeof NEUTRALS.light]> = [
    ['--color-background', 'background'],
    ['--color-surface', 'surface'],
    ['--color-surface-alt', 'surfaceAlt'],
    ['--color-surface-sunken', 'surfaceSunken'],
    ['--color-border', 'border'],
    ['--color-border-strong', 'borderStrong'],
    ['--color-text', 'text'],
    ['--color-text-secondary', 'textSecondary'],
    ['--color-text-muted', 'textMuted'],
    ['--color-text-inverse', 'textInverse'],
    ['--color-overlay', 'overlay'],
    ['--color-skeleton', 'skeleton'],
    ['--color-skeleton-highlight', 'skeletonHighlight'],
  ];

  it.each(neutralPairs)('light %s === NEUTRALS.light.%s', (cssVar, key) => {
    expect(readVar(light, cssVar)).toBe(NEUTRALS.light[key].toLowerCase());
  });

  it.each(neutralPairs)('dark %s === NEUTRALS.dark.%s', (cssVar, key) => {
    expect(readVar(dark, cssVar)).toBe(NEUTRALS.dark[key].toLowerCase());
  });

  const ragPairs: Array<[string, keyof typeof RAG.light]> = [
    ['--rag-red', 'red'],
    ['--rag-amber', 'amber'],
    ['--rag-green', 'green'],
    ['--rag-red-surface', 'redSurface'],
    ['--rag-amber-surface', 'amberSurface'],
    ['--rag-green-surface', 'greenSurface'],
  ];

  it.each(ragPairs)('light %s === RAG.light.%s', (cssVar, key) => {
    expect(readVar(light, cssVar)).toBe(RAG.light[key].toLowerCase());
  });

  it.each(ragPairs)('dark %s === RAG.dark.%s', (cssVar, key) => {
    expect(readVar(dark, cssVar)).toBe(RAG.dark[key].toLowerCase());
  });

  const statusPairs: Array<[string, keyof typeof STATUS.light]> = [
    ['--status-error', 'error'],
    ['--status-on-error', 'onError'],
    ['--status-error-surface', 'errorSurface'],
    ['--status-success', 'success'],
    ['--status-on-success', 'onSuccess'],
    ['--status-success-surface', 'successSurface'],
    ['--status-warning', 'warning'],
    ['--status-on-warning', 'onWarning'],
    ['--status-warning-surface', 'warningSurface'],
    ['--status-info', 'info'],
    ['--status-on-info', 'onInfo'],
    ['--status-info-surface', 'infoSurface'],
  ];

  it.each(statusPairs)('light %s === STATUS.light.%s', (cssVar, key) => {
    expect(readVar(light, cssVar)).toBe(STATUS.light[key].toLowerCase());
  });

  it.each(statusPairs)('dark %s === STATUS.dark.%s', (cssVar, key) => {
    expect(readVar(dark, cssVar)).toBe(STATUS.dark[key].toLowerCase());
  });

  it('brand default matches DEFAULT_BRAND', () => {
    expect(readVar(light, '--brand-primary')).toBe(
      DEFAULT_BRAND.primary.toLowerCase(),
    );
    expect(readVar(light, '--brand-secondary')).toBe(
      DEFAULT_BRAND.secondary.toLowerCase(),
    );
  });

  it('the media-query dark block and the data-theme dark block agree', () => {
    // Two dark declarations exist (OS preference, and the explicit toggle that
    // must beat it). If they ever disagree, a user toggling the theme would get
    // different colours from a user whose OS is already dark.
    const media = darkMediaBlock();
    for (const [cssVar] of [...neutralPairs, ...ragPairs, ...statusPairs]) {
      expect(readVar(media, cssVar)).toBe(readVar(dark, cssVar));
    }
    expect(readVar(media, '--shadow-color')).toBe(readVar(dark, '--shadow-color'));
  });
});

describe('the safety colours clear WCAG AA in both modes', () => {
  // Strong RAG shades are used as TEXT and icons on the page background and on
  // their own soft surface. Both pairings must clear AA for normal text.
  const modes = ['light', 'dark'] as const;

  it.each(modes)('%s: RAG text on the page background', (mode) => {
    const bg = NEUTRALS[mode].background;
    expect(contrastRatio(RAG[mode].red, bg)).toBeGreaterThanOrEqual(AA_NORMAL);
    expect(contrastRatio(RAG[mode].amber, bg)).toBeGreaterThanOrEqual(AA_NORMAL);
    expect(contrastRatio(RAG[mode].green, bg)).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it.each(modes)('%s: RAG text on its own soft surface (chips)', (mode) => {
    expect(
      contrastRatio(RAG[mode].red, RAG[mode].redSurface),
    ).toBeGreaterThanOrEqual(AA_NORMAL);
    expect(
      contrastRatio(RAG[mode].amber, RAG[mode].amberSurface),
    ).toBeGreaterThanOrEqual(AA_NORMAL);
    expect(
      contrastRatio(RAG[mode].green, RAG[mode].greenSurface),
    ).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it.each(modes)('%s: body and secondary text on the page background', (mode) => {
    const bg = NEUTRALS[mode].background;
    expect(contrastRatio(NEUTRALS[mode].text, bg)).toBeGreaterThanOrEqual(
      AA_NORMAL,
    );
    expect(
      contrastRatio(NEUTRALS[mode].textSecondary, bg),
    ).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it.each(modes)('%s: muted text clears AA for large text at least', (mode) => {
    // textMuted is reserved for captions and metadata rendered at large or
    // secondary emphasis; it is never the colour of body copy.
    const bg = NEUTRALS[mode].background;
    expect(contrastRatio(NEUTRALS[mode].textMuted, bg)).toBeGreaterThanOrEqual(
      AA_LARGE,
    );
  });

  it.each(modes)('%s: status foregrounds read on their own fills', (mode) => {
    expect(
      contrastRatio(STATUS[mode].onError, STATUS[mode].error),
    ).toBeGreaterThanOrEqual(AA_NORMAL);
    expect(
      contrastRatio(STATUS[mode].onSuccess, STATUS[mode].success),
    ).toBeGreaterThanOrEqual(AA_NORMAL);
    expect(
      contrastRatio(STATUS[mode].onInfo, STATUS[mode].info),
    ).toBeGreaterThanOrEqual(AA_NORMAL);
  });
});

describe('resolveFontStack', () => {
  // The "weird fonts when signed in" regression (2026-07-09): a seeded org
  // profile carried the bare family name "Inter", which the browser could not
  // resolve (we self-host "Inter Variable"), dropping the console to the
  // default serif. The resolver must make that class of failure impossible.
  it('returns the platform stack for absent, blank and Inter-family requests', async () => {
    const { resolveFontStack, SYSTEM_FONT_FAMILY } = await import('./tokens/typography');
    expect(resolveFontStack(undefined)).toBe(SYSTEM_FONT_FAMILY);
    expect(resolveFontStack('  ')).toBe(SYSTEM_FONT_FAMILY);
    expect(resolveFontStack('Inter')).toBe(SYSTEM_FONT_FAMILY);
    expect(resolveFontStack('inter variable')).toBe(SYSTEM_FONT_FAMILY);
  });

  it('appends the platform stack behind a genuine org font', async () => {
    const { resolveFontStack, SYSTEM_FONT_FAMILY } = await import('./tokens/typography');
    expect(resolveFontStack('Georgia')).toBe(`'Georgia', ${SYSTEM_FONT_FAMILY}`);
    expect(resolveFontStack('"Source Serif 4"')).toBe(
      `'Source Serif 4', ${SYSTEM_FONT_FAMILY}`,
    );
  });
});
