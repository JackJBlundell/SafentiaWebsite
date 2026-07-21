// ============================================================================
// AuthLayout - the shared chrome for the sign-in and password-reset screens.
//
// One centred card on the page background, the wordmark above it, a theme toggle
// pinned to the viewport corner, and a quiet route back to the marketing site
// below. Both auth screens share this file so their frame cannot drift apart.
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

export function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <div className={styles.viewport}>
        <div className={styles.corner}>
          <ThemeToggle />
        </div>
        <main className={styles.main}>
          <Wordmark size="lg" to="/" />
          <section className={styles.card}>{children}</section>
          {/* A visible way out: someone who landed here by accident should not
              need the back button to find the public site. */}
          <Link to="/" className={styles.backLink}>
            Back to the Safentia site
          </Link>
        </main>
      </div>
    </ThemeProvider>
  );
}
