// ============================================================================
// PublicLayout - the chrome every public page renders inside.
//
// It owns the three things a page must never re-implement: the skip link, the
// single <main> landmark, and scroll restoration on route change. A client-side
// router that does not reset scroll leaves a visitor halfway down the next page,
// and one that does not move focus leaves a screen-reader user stranded on the
// previous page's heading.
//
// The ThemeProvider is mounted here with no `brand` prop: public pages have no
// organisation, so the default accent from the palette applies. The console mounts
// its own provider with the signed-in organisation's brand.
// ============================================================================

import { useEffect, useRef } from 'react';
import { Outlet, ScrollRestoration, useLocation } from 'react-router-dom';
import { ThemeProvider } from '../design/ThemeProvider';
import { SiteHeader } from './SiteHeader';
import { SiteFooter } from './SiteFooter';
import styles from './PublicLayout.module.css';

export function PublicLayout() {
  const { pathname } = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const isFirstRender = useRef(true);

  // Move focus to the main landmark after a client-side navigation, so assistive
  // technology announces the new page. Skipped on first paint, where the browser
  // has already placed focus at the top of the document and stealing it would be
  // both unnecessary and disorienting.
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    mainRef.current?.focus();
  }, [pathname]);

  return (
    <ThemeProvider>
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <div className={styles.shell}>
        <SiteHeader />
        {/* tabIndex -1 makes the landmark programmatically focusable without
            adding it to the tab order. */}
        <main id="main" ref={mainRef} tabIndex={-1} className={styles.main}>
          <Outlet />
        </main>
        <SiteFooter />
      </div>
      <ScrollRestoration />
    </ThemeProvider>
  );
}
