// ============================================================================
// SiteHeader - the public site's navigation.
//
// Two rules this component enforces, because they are the ones that rot:
//   1. Every entry in NAV_LINKS points at a route that exists in routes.tsx.
//      There are no dead links and no unfinished entries.
//   2. "Get started" is the primary account action: self-serve sign-up is live
//      (Phase 3), so the door to the console at /login is where a new
//      organisation begins the subscribe journey. "Sign in" stays alongside it
//      for returning users; booking a demonstration lives on the pages as the
//      quieter guided path, not in the header.
//
// The mobile menu is a plain disclosure, not a modal: focus stays in document
// order, Escape closes it, and it never traps a keyboard user.
// ============================================================================

import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { Wordmark } from '../components/Wordmark';
import { Button } from '../components/Button';
import { ThemeToggle } from '../components/ThemeToggle';
import styles from './SiteHeader.module.css';

/** The public navigation. Keep in step with the public routes in routes.tsx. */
const NAV_LINKS = [
  { to: '/how-it-works', label: 'How it works' },
  { to: '/about', label: 'About' },
  { to: '/news', label: 'News' },
  { to: '/faq', label: 'FAQ' },
] as const;

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const toggleRef = useRef<HTMLButtonElement>(null);

  // Navigating away closes the menu. Without this, a client-side route change
  // leaves the panel open over the new page.
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  // Escape closes and returns focus to the control that opened it.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <Wordmark to="/" priority />

        <nav className={styles.desktopNav} aria-label="Primary">
          <ul className={styles.navList}>
            {NAV_LINKS.map((link) => (
              <li key={link.to}>
                <NavLink
                  to={link.to}
                  className={({ isActive }) =>
                    isActive ? `${styles.navLink} ${styles.navLinkActive}` : styles.navLink
                  }
                >
                  {link.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className={styles.actions}>
          <ThemeToggle />
          <span className={styles.desktopOnly}>
            <Button to="/login" variant="ghost">
              Sign in
            </Button>
          </span>
          <span className={styles.desktopOnly}>
            <Button to="/signup" variant="primary">
              Get started
            </Button>
          </span>

          <button
            ref={toggleRef}
            type="button"
            className={styles.menuButton}
            aria-expanded={open}
            aria-controls="site-menu"
            onClick={() => setOpen((value) => !value)}
          >
            <span className="sr-only">{open ? 'Close menu' : 'Open menu'}</span>
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              {open ? (
                <path d="M6 6l12 12M18 6L6 18" />
              ) : (
                <path d="M4 7h16M4 12h16M4 17h16" />
              )}
            </svg>
          </button>
        </div>
      </div>

      <div id="site-menu" className={styles.mobileMenu} hidden={!open}>
        <nav aria-label="Primary, mobile">
          <ul className={styles.mobileList}>
            {NAV_LINKS.map((link) => (
              <li key={link.to}>
                <NavLink to={link.to} className={styles.mobileLink}>
                  {link.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className={styles.mobileActions}>
          <Button to="/login" variant="secondary" block>
            Sign in
          </Button>
          <Button to="/signup" variant="primary" block>
            Get started
          </Button>
        </div>
      </div>
    </header>
  );
}
