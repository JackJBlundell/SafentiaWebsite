// ============================================================================
// AuthLayout - the shared chrome for the sign-in, password-reset and invitation
// screens.
//
// Two halves: the form on a plain surface, and a brand panel that says what this
// portal is for. The panel exists because /login and /invite are frequently the
// FIRST Safentia screen a customer contact ever sees, and a bare form tells them
// nothing. Every claim on it is lifted from the public marketing pages (the home
// page hero and its three-up); nothing here is invented, because this is a
// regulated fire-safety product and a fabricated capability is worse than no
// copy at all.
//
// Colour discipline (tokens.css): the gold is a FILL, never type. The panel is a
// large gold field carrying near-black text (12.15:1), which is the intended way
// to use the accent at scale. No rule below sets --brand-primary as a `color`.
//
// Layout order is form-then-panel in the DOM, which gives the form the left
// column on wide screens and puts it FIRST on a phone, so the marketing never
// pushes the sign-in below the fold and the keyboard reaches the form first.
//
// The panel carries no headings, so the heading order the three routes set up
// (each owns its own h1) is untouched, and the artwork is aria-hidden.
//
// It wraps its children in the default ThemeProvider (no org brand: nobody is
// signed in yet, so there is no organisation to brand for). Nothing here touches
// `window` at render time - these routes are pre-rendered like every other page,
// and the ThemeProvider already defers environment reads to effects.
// ============================================================================

import React from 'react';
import { Link } from 'react-router-dom';
import { ThemeProvider } from '../../design/ThemeProvider';
import { Wordmark } from '../../components/Wordmark';
import { ThemeToggle } from '../../components/ThemeToggle';
import styles from './AuthLayout.module.css';

/**
 * What the product does, in the marketing site's own words: these three lines
 * are the home page's "From the field to a released report" cards, trimmed to
 * their first sentence. Keeping them identical means the promise made to a
 * visitor on safentia.co.uk is the promise repeated at the door.
 */
const PROMISES = [
  {
    title: 'Capture offline',
    line: 'Templated questions, titled photo evidence and floor-plan flags on a native app.',
  },
  {
    title: 'Validate with named stages',
    line: 'Every assessment moves through a fixed lifecycle, from Assessment in progress to Released.',
  },
  {
    title: 'Release a branded report',
    line: 'On release, a formal PDF is generated server-side: risk profile, transparent question tables and a severity-ordered action plan.',
  },
] as const;

/** A 16px tick, currentColour, matching the icon vocabulary of the home page. */
const Tick = (
  <svg
    className={styles.tick}
    viewBox="0 0 24 24"
    width={16}
    height={16}
    fill="none"
    stroke="currentColor"
    strokeWidth={2.4}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M4.5 12.5 9.5 17.5 19.5 6.5" />
  </svg>
);

/**
 * Decorative circles for the brand panel.
 *
 * This was a line drawing - a building footprint with door swings, a stair core
 * and two concentric rings. It was competing with the words: at any weight dark
 * enough to see, an outlined PLAN invites you to read it as information, and the
 * one thing a sign-in panel must not do is give you something to work out.
 * Overlapping discs carry the same job (break up a large flat field) while
 * saying nothing at all.
 *
 * Painted in `currentColor`, which on this panel is the type's near-black ink,
 * at low alpha - so every circle DARKENS the brand ground it falls on. That is
 * what makes them safe: the copy's contrast can only go up where they overlap
 * it, never down. Sized generously and `slice`-scaled so they bleed off every
 * edge at any aspect ratio rather than sitting in the middle like a diagram, and
 * hidden from assistive technology because they mean nothing.
 */
const PanelArt = (
  <svg
    className={styles.panelArt}
    viewBox="0 0 480 640"
    preserveAspectRatio="xMidYMid slice"
    aria-hidden="true"
    focusable="false"
  >
    <g fill="currentColor">
      {/* Deliberately uneven: three sizes at three alphas, each bleeding off an
          edge, so the field reads as depth rather than as a pattern. */}
      <circle cx="70" cy="104" r="190" opacity="0.10" />
      <circle cx="430" cy="250" r="140" opacity="0.07" />
      <circle cx="150" cy="560" r="220" opacity="0.09" />
      <circle cx="404" cy="596" r="96" opacity="0.06" />
      <circle cx="286" cy="368" r="58" opacity="0.05" />
    </g>
  </svg>
);
export function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <div className={styles.viewport}>
        <div className={styles.formSide}>
          <div className={styles.formInner}>
            <header className={styles.topBar}>
              <Wordmark size="lg" to="/" />
              <ThemeToggle />
            </header>
            <section className={styles.card}>{children}</section>
            {/* A visible way out: someone who landed here by accident should not
                need the back button to find the public site. */}
            <Link to="/" className={styles.backLink}>
              Back to the Safentia site
            </Link>
          </div>
        </div>

        <aside className={styles.brandSide}>
          {PanelArt}
          <div className={styles.panelInner}>
            <p className={styles.eyebrow}>The Safentia console</p>
            {/* Styled as display type rather than a heading, so the form's own
                h1 remains the first and only heading on the page. */}
            <p className={styles.panelTitle}>Fire risk assessment, evidenced.</p>
            <p className={styles.panelLead}>
              Assessors capture evidence on site, auditors validate it question
              by question, and the Responsible Person receives a report they can
              act on.
            </p>
            <ul className={styles.promises}>
              {PROMISES.map((promise) => (
                <li key={promise.title} className={styles.promise}>
                  {Tick}
                  <span>
                    <strong className={styles.promiseTitle}>
                      {promise.title}
                    </strong>
                    <span className={styles.promiseLine}>{promise.line}</span>
                  </span>
                </li>
              ))}
            </ul>
            <p className={styles.panelFoot}>
              Invited by the organisation that assesses your buildings? Signing
              in shows you your own buildings, scores and released reports.
            </p>
          </div>
        </aside>
      </div>
    </ThemeProvider>
  );
}
