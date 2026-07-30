// ============================================================================
// Shared pieces for the customer portal (FR-E22): the portal scope hook every
// portal screen reads, the portal's browser URLs, and the severity chip the
// action plan renders. One definition each, mirroring customers/shared.tsx.
//
// The portal is READ-ONLY over RTDB by design (stories 2057/2058): no screen
// here writes to the database directly, and every portal grant in the rules is
// `.read` only. The ONE mutation a contact can make is accepting a report, and
// it goes through the acceptReport callable, which re-derives their right to
// accept server-side - the database rules still deny the write outright.
// ============================================================================

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { useTheme } from '../../design/ThemeProvider';
import { severityPresentation } from '../../design/rag';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type { EnvPaths } from '../../paths';
import type { OrgContact, OrgProfile, Severity } from '../../types';
import styles from './shared.module.css';

// ----------------------------------------------------------------------------
// Portal scope - which customer is looking, at which org's data.
// ----------------------------------------------------------------------------

export interface PortalScope {
  /** False only in the brief window before claims resolve; screens keep their
   *  queries disabled until this is true. */
  ready: boolean;
  /** The fire-safety organisation whose data the portal exposes. */
  orgId: string;
  /** The customer this session belongs to; scopes every read. */
  customerId: string;
  /** True when this session holds the customer ADMIN role - the gate for the
   *  team-management surface. Convenience only: the portalInviteTeammate
   *  callable re-checks the customer role server-side, so a UI slip can never
   *  grant access. */
  isAdmin: boolean;
  /** This session's own account id, so a screen can tell WHICH row in a list is
   *  the person reading it - the team page needs it to stop an admin removing
   *  their own administrator role. Empty until the session resolves. */
  uid: string;
  db: EnvPaths['db'] | null;
}

export function usePortalScope(): PortalScope {
  const { claims, paths, user } = useAuth();
  const isPortal = claims?.kind === 'portal';
  return {
    ready: Boolean(isPortal && paths),
    orgId: isPortal ? claims.orgId : '',
    customerId: isPortal ? claims.customerId : '',
    isAdmin: isPortal ? claims.customerRoles.admin === true : false,
    uid: isPortal ? (user?.uid ?? '') : '',
    db: paths?.db ?? null,
  };
}

// ----------------------------------------------------------------------------
// Read state - the three states a portal read can honestly be in.
// ----------------------------------------------------------------------------

/**
 * What a portal screen knows about one RTDB read.
 *
 *   loading - nothing has come back yet (including "the claim has not resolved
 *             so the subscription is still disabled"). Show a skeleton.
 *   ready   - the listener has delivered a value. That value may be `null`,
 *             which is a SUCCESS meaning the node is empty, not a failure.
 *   failed  - the read failed and we have no value at all. Show a retryable
 *             error and never a zero.
 */
export type PortalReadStatus = 'loading' | 'ready' | 'failed';

/** The two fields of a query result this derivation needs. Deliberately not
 *  `UseQueryResult`, so a caller can hand down a narrowed shape. */
export interface PortalRead {
  /** `undefined` means "no value yet"; `null` means "the node is empty". */
  data: unknown;
  isError: boolean;
}

/**
 * Derive the honest read state, with the LISTENER as the authority.
 *
 * Why not `isLoading` / `isError` directly: useRtdbQuery feeds one cache entry
 * from two places - the live listener (which writes every snapshot in) and a
 * one-shot `get()` that only exists so the first paint is not blank. Those two
 * can disagree. `get()` does a server round trip and rejects outright when the
 * socket is not up yet (a token refresh, a reconnect), which flips the query's
 * status to `error` even though the listener has already delivered a perfectly
 * good value. React Query keeps that value in `data`, so the screen holds the
 * truth while its status flags claim a failure.
 *
 * A node with rows heals itself - the next child event writes another snapshot
 * in and the status returns to success. An EMPTY node never does: an absent
 * node fires exactly once, with `null`, and then stays silent forever. That is
 * why only never-assessed buildings and empty estates got stuck, and why the
 * seeded demo data never showed it.
 *
 * So: if a value has arrived, the read is ready, whatever the fetch lifecycle
 * says afterwards. Only a read with NO value can be loading or failed.
 */
export function portalReadStatus(read: PortalRead): PortalReadStatus {
  if (read.data !== undefined) {
    return 'ready';
  }
  return read.isError ? 'failed' : 'loading';
}

// ----------------------------------------------------------------------------
// The assessing organisation's identity.
// ----------------------------------------------------------------------------

/** The whitelabel identity a portal screen may put on the page. Every field is
 *  optional: most organisations set some of their branding and not all of it,
 *  so partial branding is the NORMAL case and each consumer degrades on its
 *  own rather than waiting for a complete profile. */
export interface PortalOrgIdentity {
  /** The organisation's trading name, once the profile has resolved. */
  name: string | undefined;
  /** Their logo, if they have uploaded one. */
  logoUrl: string | undefined;
  /** Their published contact details, for "who do I ask" copy in the chrome and
   *  footer. Any field may be absent; the consumer shows what is set and no
   *  more, so a partial contact block is normal rather than broken. */
  contact: OrgContact | undefined;
}

/** Unbranded: what a consumer sees before the profile resolves, and what it
 *  keeps seeing if the read is denied. Every consumer already handles it. */
const NO_ORG_IDENTITY: PortalOrgIdentity = {
  name: undefined,
  logoUrl: undefined,
  contact: undefined,
};

const PortalOrgContext = createContext<PortalOrgIdentity>(NO_ORG_IDENTITY);

/**
 * Owns the ONE portal-side subscription to the assessing organisation's
 * profile and shares it with every screen beneath. Portal tokens are admitted
 * to that node by the `portalOrgId` arm of its rule - a customer being able to
 * see who assessed their buildings is the point of the portal - and the grant
 * covers the profile node alone.
 *
 * A context rather than a hook per consumer: the brand mark in the chrome and
 * the copy on the home screen both want the org's name, and two hooks would
 * mean two listeners on one node for no gain (CONVENTIONS 2).
 */
export function PortalOrgProvider({ children }: { children: ReactNode }) {
  const { ready, orgId, db } = usePortalScope();
  const profile = useRtdbQuery<OrgProfile | null>({
    key: keys.orgProfile(orgId || 'none'),
    path: ready && db ? db.orgProfile(orgId) : 'none',
    enabled: ready,
  });

  const name = profile.data?.name;
  const logoUrl = profile.data?.logoUrl;
  const contact = profile.data?.contact;
  const identity = useMemo<PortalOrgIdentity>(
    () => ({ name, logoUrl, contact }),
    [name, logoUrl, contact],
  );

  return (
    <PortalOrgContext.Provider value={identity}>
      {children}
    </PortalOrgContext.Provider>
  );
}

/** The assessing organisation's identity. Outside the provider it reads as
 *  unbranded rather than throwing: an unbranded portal is a correct, if plain,
 *  page, and a customer must never lose their fire safety position to a
 *  wiring mistake in the chrome. */
export function usePortalOrgIdentity(): PortalOrgIdentity {
  return useContext(PortalOrgContext);
}

// ----------------------------------------------------------------------------
// Router URLs. RTDB paths come from useAuth().paths.db; these are the browser
// routes, kept here so a moved route changes in one place.
// ----------------------------------------------------------------------------

export const portalUrls = {
  home: '/app',
  account: '/app/account',
  /** The "my team" surface: a customer admin sees their team and invites a
   *  teammate. Admin-only in the chrome and self-gated on the page; the callable
   *  it drives re-checks the customer role server-side regardless. */
  team: '/app/team',
  building: (siteId: string, buildingId: string) =>
    `/app/sites/${siteId}/buildings/${buildingId}`,
  /** One report's acceptance/download screen. Mirrors the URL the released-report
   *  email builds server-side (functions/src/functions/onAssessmentStageChange),
   *  so the two must move together. */
  report: (siteId: string, buildingId: string, reportId: string) =>
    `/app/sites/${siteId}/buildings/${buildingId}/reports/${reportId}`,
} as const;

// ----------------------------------------------------------------------------
// Small presentational pieces.
// ----------------------------------------------------------------------------

/** The L/M/H severity chip: fixed safety colour plus label, so colour is never
 *  the sole carrier (same rule as the RAG chip). */
export function SeverityChip({ severity }: { severity: Severity }) {
  const { theme } = useTheme();
  const tone = severityPresentation(theme, severity);
  return (
    <span
      className={styles.severityChip}
      style={{ color: tone.color, background: tone.surface }}
    >
      <span aria-hidden="true">{tone.icon}</span>
      {tone.label}
    </span>
  );
}
