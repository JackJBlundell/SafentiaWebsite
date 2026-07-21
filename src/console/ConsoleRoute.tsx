// ============================================================================
// ConsoleRoute - the lazily-loaded entry into the signed-in console.
//
// This module is where the Firebase Web SDK first enters the bundle, which is why
// it is lazy: a visitor reading the marketing site must never download it.
//
// It is nonetheless PRE-RENDERED, as the splash that Hosting serves for every
// /app/** URL. That imposes one rule on everything below it: no module may touch
// `window`, `localStorage` or a Firebase service at import time or during the
// first render. `startFirebase()` is called from an effect, which never runs in
// the pre-render pass, so the emitted HTML is exactly the splash.
//
// Named exports `Component` and `loader` are the shape react-router's `lazy`
// expects.
// ============================================================================

import { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { startFirebase } from '../firebase';
import { AuthProvider, useAuth } from '../auth/AuthProvider';
import type { SessionClaims } from '../auth/claims';
import type { EnvPaths } from '../paths';
import { queryClient } from '../query/queryClient';
import { keys } from '../query/keys';
import { useRtdbQuery } from '../query/useRtdbQuery';
import { ThemeProvider } from '../design/ThemeProvider';
import { Seo } from '../seo/Seo';
import { Wordmark } from '../components/Wordmark';
import { HoldingScreen } from './HoldingScreen';
import { ConsoleShell } from './ConsoleShell';
import { PortalShell } from './portal/PortalShell';
import type { OrgProfile } from '../types';

/**
 * The splash. Identical output on the server and on the first client frame, so
 * hydration never has to correct it.
 */
function ConsoleSplash() {
  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'grid',
        placeItems: 'center',
        background: 'var(--color-background)',
      }}
    >
      <Wordmark size="lg" />
      {/* The splash is a loading state, and it says so to assistive technology
          without shouting it at a sighted user. The heading keeps the emitted
          app.html a well-formed document (every page has an h1). */}
      <h1 className="sr-only">Safentia console</h1>
      <span className="sr-only" role="status">
        Loading your organisation
      </span>
    </div>
  );
}

export function Component() {
  // `mounted` flips only in the browser. Until it does we render the splash, which
  // is precisely what the pre-render should emit.
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    startFirebase();
    setMounted(true);
  }, []);

  return (
    <>
      {/* The console must never enter a search index (story 2075 AC3). */}
      <Seo
        title="Console"
        description="The Safentia management console."
        path="/app"
        noIndex
      />
      {mounted ? (
        <ConsoleRoot />
      ) : (
        <ThemeProvider>
          <ConsoleSplash />
        </ThemeProvider>
      )}
    </>
  );
}

/**
 * The browser-only root: auth resolution and the shared query cache. Everything
 * from here down may touch Firebase, because the mounted gate above guarantees
 * we are past the pre-render pass.
 */
function ConsoleRoot() {
  return (
    <AuthProvider>
      <QueryClientProvider client={queryClient}>
        <ConsoleGate />
      </QueryClientProvider>
    </AuthProvider>
  );
}

/**
 * Route on the session state. Each branch owns its OWN ThemeProvider (never
 * nested) so the org-branded provider's CSS custom properties are not
 * overwritten by a plain parent's effect re-running with the defaults.
 */
function ConsoleGate() {
  const { status, claims, paths } = useAuth();
  const location = useLocation();

  if (status === 'initialising') {
    return (
      <ThemeProvider>
        <ConsoleSplash />
      </ThemeProvider>
    );
  }

  if (status === 'signedOut') {
    // Carry the console URL the visitor asked for, so signing in returns them
    // to it instead of dumping them on the console home.
    const returnTo = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?returnTo=${returnTo}`} replace />;
  }

  if (status === 'noMembership') {
    return (
      <ThemeProvider>
        <HoldingScreen />
      </ThemeProvider>
    );
  }

  // status === 'authenticated': the contract guarantees claims and paths are
  // set, but we gate defensively so a provider bug shows the splash, not a crash.
  if (!claims || !paths) {
    return (
      <ThemeProvider>
        <ConsoleSplash />
      </ThemeProvider>
    );
  }

  // The third landing (story 2005): a customer-portal session gets the portal
  // shell, never the staff console. Default theme deliberately - a portal token
  // cannot read the org profile that drives the whitelabel brand (staff-only
  // rule); PortalShell documents the limitation and brands with the customer's
  // own name instead.
  if (claims.kind === 'portal') {
    return (
      <ThemeProvider>
        <PortalShell />
      </ThemeProvider>
    );
  }

  return <BrandedConsole claims={claims} paths={paths} />;
}

/**
 * The authenticated console under the organisation's whitelabel theme. The org
 * profile arrives live via the RTDB bridge; until it resolves, the default
 * brand from tokens.css applies, and the swap is a repaint rather than a remount.
 */
function BrandedConsole({
  claims,
  paths,
}: {
  claims: SessionClaims;
  paths: EnvPaths;
}) {
  const profile = useRtdbQuery<OrgProfile | null>({
    key: keys.orgProfile(claims.orgId),
    path: paths.db.orgProfile(claims.orgId),
  });

  return (
    <ThemeProvider
      brand={profile.data?.brand}
      logoUrl={profile.data?.logoUrl}
      fontFamily={profile.data?.fontFamily}
    >
      <ConsoleShell />
    </ThemeProvider>
  );
}
