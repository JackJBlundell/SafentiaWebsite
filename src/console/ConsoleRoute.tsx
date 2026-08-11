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

import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { startFirebase } from '../firebase';
import { AuthProvider, useAuth } from '../auth/AuthProvider';
import { useUserSpaces } from '../auth/useUserSpaces';
import { useSuperAdminClaim } from './admin/useSuperAdminClaim';
import { hasChosenSpace } from '../auth/spaceChoice';
import { SpacePicker } from './SpacePicker';
import { type EnvPaths } from '../paths';
import { queryClient } from '../query/queryClient';
import { keys } from '../query/keys';
import { useRtdbQuery } from '../query/useRtdbQuery';
import { ThemeProvider } from '../design/ThemeProvider';
import { Seo } from '../seo/Seo';
import { Wordmark } from '../components/Wordmark';
import { EmailVerificationScreen } from './EmailVerificationScreen';
import { ConsoleShell } from './ConsoleShell';
import { PortalShell } from './portal/PortalShell';
import { pickNoMembershipView } from './billing/gating';
import { useEntitlements } from './billing/useEntitlements';
import { useOnboardingNode } from './billing/useOnboardingNode';
import { ConfirmingScreen } from './billing/ConfirmingScreen';
// Type-only: erased at build time, so the lazy chunk boundary is untouched.
import type { SetupSummary } from './billing/SetupCompleteScreen';
import type { OrgProfile } from '../types';

// The two Phase 3 onboarding gates are their own chunk: everything that faces
// Stripe stays out of the main console bundle, and the overwhelming majority
// of sessions (existing members) never download either. Lazy at module scope
// is SSG-safe - nothing loads until a render actually reaches a gate.
const SubscribeGate = lazy(() => import('./billing/SubscribeGate'));
const SetupGate = lazy(() => import('./billing/SetupGate'));
const SetupCompleteScreen = lazy(() => import('./billing/SetupCompleteScreen'));

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
  const { status, claims, paths, emailVerified, user } = useAuth();
  const location = useLocation();
  // Both halves of the account's spaces. The hook is inert until there is a
  // session, so calling it here costs nothing on the signed-out branches below.
  const spaces = useUserSpaces();
  // Whether this account holds the platform grant, so a super admin can reach
  // /app/admin from any space (including a portal one). 'loading' reads as not
  // granted, so a portal super admin at /app/admin sees the portal briefly
  // until the claim resolves, then the platform shell - never a hard denial.
  const isSuperAdmin = useSuperAdminClaim() === 'granted';
  // Set when the picker on THIS mount has been answered; sessionStorage carries
  // the same answer across a reload. Read during render deliberately: it is a
  // synchronous, stable value, and deferring it to an effect would flash the
  // picker at somebody who has already chosen.
  const [pickedHere, setPickedHere] = useState(false);
  const uid = user?.uid ?? null;
  const spaceSettled = pickedHere || (uid !== null && hasChosenSpace(uid));

  // The picker is a convenience, never a permission: the claims already name a
  // space the session may use. So the wait for the two indexes is BOUNDED - a
  // browser that cannot reach the database (offline, a blocked socket) would
  // otherwise leave the console on its splash indefinitely, which is a far worse
  // outcome than not being asked the question. Anyone who missed the question
  // can still move between spaces from the switcher.
  const [waitedForSpaces, setWaitedForSpaces] = useState(false);
  useEffect(() => {
    if (spaceSettled || !spaces.loading) {
      return;
    }
    const timer = setTimeout(() => setWaitedForSpaces(true), 4_000);
    return () => clearTimeout(timer);
  }, [spaceSettled, spaces.loading]);

  // The caller's self-serve onboarding node (Phase 3 §3.1/§5.4, owner-read) -
  // the single resume point for the subscribe -> pay -> provision -> wizard
  // journey. Read lazily: only past email verification, and only for the
  // sessions a billing gate could actually apply to - a membership-less one
  // (is a subscribe underway?) or a claimed STAFF one (is the setup wizard
  // unfinished?). Portal sessions never onboard an organisation, so they
  // never read the node at all. The hook picks the read posture: a live
  // listener while the subscribe journey is in motion, one cached get() for
  // the claimed majority whose node is simply absent.
  const onboardingEnabled =
    uid !== null &&
    emailVerified &&
    (status === 'noMembership' ||
      (status === 'authenticated' && claims?.kind !== 'portal'));
  const onboardingQuery = useOnboardingNode(uid, {
    enabled: onboardingEnabled,
    wantLive: status === 'noMembership',
  });
  // Same BOUNDED wait as the spaces read above, for the same reason: the gates
  // are routing decisions, and a browser that cannot reach the database must
  // not sit on the splash forever waiting for one. On timeout the node reads
  // as absent, which fails towards the ordinary (pre-Phase-3) behaviour.
  const [waitedForOnboarding, setWaitedForOnboarding] = useState(false);
  useEffect(() => {
    if (!onboardingEnabled || !onboardingQuery.isLoading) {
      return;
    }
    const timer = setTimeout(() => setWaitedForOnboarding(true), 4_000);
    return () => clearTimeout(timer);
  }, [onboardingEnabled, onboardingQuery.isLoading]);
  const onboardingSettled =
    !onboardingEnabled || !onboardingQuery.isLoading || waitedForOnboarding;
  // A denied/errored read degrades to "no journey" rather than surfacing: the
  // server remains the boundary, and the fallback views are all safe.
  const onboarding = onboardingQuery.isError
    ? null
    : (onboardingQuery.data ?? null);

  // The setup wizard's "Finish setup" celebration. Held HERE, not in the gate:
  // advanceOnboarding({finish: true}) flips the node to 'done' almost at once,
  // which unmounts SetupGate (and the wizard) below - this component is the
  // nearest thing that survives the flip. While the flag is set the
  // celebration renders regardless of node state; the CTA clears it and the
  // session falls through to the shell. A reload during the celebration lands
  // straight on the dashboard (the node is done) - acceptable, it is a one-off
  // flourish, not state anyone needs back.
  const [setupCelebration, setSetupCelebration] = useState<SetupSummary | null>(
    null,
  );

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

  // Hard gate, ABOVE the staff/portal split so it covers BOTH landings: an
  // unconfirmed email address never reaches ConsoleShell or PortalShell.
  //
  // DEPLOYMENT ORDER, DO NOT REORDER: acceptInvitation only started stamping
  // emailVerified recently, so every account created before that - including the
  // live field-test assessor accounts - is still recorded as unverified and this
  // gate WILL lock them out. Run
  // functions/src/scripts/backfillEmailVerified.ts (dry, then --apply) against
  // the target project BEFORE shipping this gate. EmailVerificationScreen
  // re-reads the account record on mount, so an account repaired by that script
  // is admitted on the next reload rather than being stranded behind a stale
  // client-side snapshot.
  if (!emailVerified) {
    return (
      <ThemeProvider>
        <EmailVerificationScreen />
      </ThemeProvider>
    );
  }

  // A verified account with no membership is where self-serve onboarding
  // lives (Phase 3 §3.1). The onboarding node decides the view: no journey
  // (or an abandoned/finished one) gets the subscribe pitch - which carries
  // the "expecting an invitation?" swap to the old HoldingScreen default; a
  // journey at 'payment' resumes inside the same gate; a journey at 'setup'
  // means the org exists and the freshly-minted claims are seconds away, so
  // the confirming screen polls for them. The splash holds only until the
  // node's BOUNDED first read settles.
  if (status === 'noMembership') {
    if (!onboardingSettled) {
      return (
        <ThemeProvider>
          <ConsoleSplash />
        </ThemeProvider>
      );
    }
    if (pickNoMembershipView('noMembership', onboarding) === 'confirming') {
      return (
        <ThemeProvider>
          <ConfirmingScreen />
        </ThemeProvider>
      );
    }
    // 'subscribe' or 'payment': SubscribeGate reads the node's step itself to
    // choose between the plan matrix and the resumed payment page.
    return (
      <ThemeProvider>
        <Suspense fallback={<ConsoleSplash />}>
          <SubscribeGate onboarding={onboarding} />
        </Suspense>
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

  // Between the claims guard and the space picker (Phase 3 §3.1 gate order): a
  // founding admin whose organisation was just provisioned but whose setup
  // wizard is unfinished gets the wizard, not the shell. Scoped to the ACTIVE
  // org - a node left over from onboarding a DIFFERENT organisation must not
  // gate a session that was since invited elsewhere - and released the moment
  // the server stamps completedAt (or step 'done'). The splash covers the
  // node's bounded first read for staff sessions; portal sessions never read
  // it, so they settle immediately.
  if (!onboardingSettled) {
    return (
      <ThemeProvider>
        <ConsoleSplash />
      </ThemeProvider>
    );
  }
  if (setupCelebration) {
    return (
      <ThemeProvider>
        <Suspense fallback={<ConsoleSplash />}>
          <SetupCompleteScreen
            summary={setupCelebration}
            onContinue={() => setSetupCelebration(null)}
          />
        </Suspense>
      </ThemeProvider>
    );
  }
  const activeOrgOnboarding =
    onboarding && onboarding.orgId === claims.orgId ? onboarding : null;
  if (
    activeOrgOnboarding &&
    pickNoMembershipView('authenticated', activeOrgOnboarding) === 'setup'
  ) {
    return (
      <ThemeProvider>
        <Suspense fallback={<ConsoleSplash />}>
          <SetupGate
            onboarding={activeOrgOnboarding}
            onCelebrate={setSetupCelebration}
          />
        </Suspense>
      </ThemeProvider>
    );
  }

  // The two-half question, asked once per tab session and ONLY of the minority
  // who hold more than one space: signing in must not silently drop somebody
  // into whichever space their last claims happened to name. It sits below the
  // verification and membership gates (an unverified or membership-less account
  // has nothing to choose between) and above the staff/portal split, because the
  // choice is precisely which of those two the session becomes.
  //
  // Rendered in place rather than redirected to, so a deep link into the console
  // survives the choice and resolves the moment it is made.
  if (!spaceSettled && !waitedForSpaces) {
    if (spaces.loading) {
      return (
        <ThemeProvider>
          <ConsoleSplash />
        </ThemeProvider>
      );
    }
    if (spaces.hasMultiple) {
      return (
        <ThemeProvider>
          <SpacePicker
            spaces={spaces.spaces}
            onChosen={() => setPickedHere(true)}
          />
        </ThemeProvider>
      );
    }
    // Exactly one space (the overwhelming majority): no question to ask, and
    // nothing recorded - there is nothing they could be asked next time either.
  }

  // The platform console lives inside ConsoleShell (it swaps its own chrome
  // under /app/admin). A super admin can hold a PORTAL claim - the two are not
  // exclusive - and would then land in PortalShell, where /app/admin is not a
  // route, so a switch to the dashboard showed "nothing here" over the portal
  // UI. So a super admin who is actually AT /app/admin gets ConsoleShell
  // whatever their space claim is; AdminRoutes reads platform data off the
  // superAdmin claim, not the org claim, so the portal claim is irrelevant there.
  const inPlatform = location.pathname.startsWith('/app/admin');
  const usePlatformShell = isSuperAdmin && inPlatform;

  // The third landing (story 2005): a customer-portal session gets the portal
  // shell, never the staff console. Both landings wear the SAME whitelabel
  // brand: a portal token reads /organisations/{orgId}/profile through the
  // portalOrgId arm of that node's rule, so a customer sees the identity of the
  // organisation that assessed their buildings rather than bare Safentia.
  return (
    <BrandedShell orgId={claims.orgId} paths={paths} platformMode={usePlatformShell}>
      {claims.kind === 'portal' && !usePlatformShell ? (
        <PortalShell />
      ) : (
        <ConsoleShell />
      )}
    </BrandedShell>
  );
}

/**
 * The authenticated app under the organisation's whitelabel theme, staff or
 * portal. The org profile arrives live via the RTDB bridge; until it resolves,
 * the default brand from tokens.css applies, and the swap is a repaint rather
 * than a remount. Chrome that needs the profile's own fields (name, logo)
 * subscribes to `keys.orgProfile` too, which is the same cache entry and the
 * same single listener, never a second one.
 *
 * The stored brand is APPLIED only when the org is entitled to it (Phase 3
 * §6.3 - the same applyBrandingEntitlement rule the report cover and themed
 * emails enforce server-side):
 *   - the entitlement resolution must be settled AND grant `branding` - a
 *     silver/gold or grandfathered org keeps its whitelabel, a bronze org
 *     renders the Safentia default. While the billing reads attach, the
 *     default applies too, so a bronze admin never sees a flash of their
 *     stored brand before the gate lands (default-first is this shell's
 *     documented posture for the profile read already);
 *   - the member-readable `profile.suspended` mirror must be clear - it is
 *     what lets non-admin staff and portal sessions (which cannot read the
 *     subscription and resolve the grandfather posture) drop the whitelabel
 *     the moment the webhook suspends the org. A bronze org's non-admin
 *     sessions have no readable plan signal, so they keep the whitelabel
 *     until an admin session or a server render tells them otherwise -
 *     presentation only, the server strips every artefact regardless;
 *   - PLATFORM MODE (a super admin under /app/admin) forces the default
 *     Safentia chrome outright: operator surfaces are never whitelabelled,
 *     whatever the tenant's or the operator's own org entitles. The flag is
 *     derived from the same render's location, so entering or leaving
 *     /app/admin swaps in the same frame - no flash of tenant colours.
 */
function BrandedShell({
  orgId,
  paths,
  platformMode,
  children,
}: {
  orgId: string;
  paths: EnvPaths;
  /** True when this render is the operator (platform) shell under /app/admin. */
  platformMode: boolean;
  children: ReactNode;
}) {
  const profile = useRtdbQuery<OrgProfile | null>({
    key: keys.orgProfile(orgId),
    path: paths.db.orgProfile(orgId),
  });
  const billing = useEntitlements();

  const applyBrand =
    !platformMode &&
    !billing.loading &&
    billing.entitlements.features.branding &&
    profile.data?.suspended !== true;

  return (
    <ThemeProvider
      brand={applyBrand ? profile.data?.brand : undefined}
      logoUrl={applyBrand ? profile.data?.logoUrl : undefined}
      fontFamily={applyBrand ? profile.data?.fontFamily : undefined}
    >
      {children}
    </ThemeProvider>
  );
}
