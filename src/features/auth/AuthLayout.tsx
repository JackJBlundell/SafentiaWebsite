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
 * Decorative plan geometry for the brand panel. The repo ships no photography
 * and the marketing pages use none, so visual interest is authored here: a
 * building footprint with door swings and a stair core, over the document rules
 * that stand in for a report. It is `slice`-scaled so it fills the panel at any
 * aspect ratio, and it is hidden from assistive technology because it says
 * nothing the copy beside it does not.
 */
const PanelArt = (
  <svg
    className={styles.panelArt}
    viewBox="0 0 480 640"
    preserveAspectRatio="xMidYMid slice"
    aria-hidden="true"
    focusable="false"
  >
    <g fill="none" stroke="currentColor" strokeWidth={1.5}>
      <rect x="56" y="72" width="368" height="272" rx="8" />
      <path d="M56 224h152M208 72v152M208 292h216M312 224v120" />
      {/* Door swings: the detail that makes the outline read as a plan. */}
      <path d="M208 176a48 48 0 0 0 48 48" />
      <path d="M312 292a40 40 0 0 1-40 40" />
      {/* Stair core. */}
      <rect x="76" y="244" width="72" height="84" rx="4" />
      <path d="M76 264h72M76 285h72M76 306h72" />
      <circle cx="344" cy="480" r="78" />
      <circle cx="344" cy="480" r="50" />
    </g>
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth={9}
      strokeLinecap="round"
      opacity="0.7"
    >
      <path d="M96 436h136M96 480h96M96 524h136M96 568h72" />
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
