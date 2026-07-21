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

import { useAuth } from '../../auth/AuthProvider';
import { useTheme } from '../../design/ThemeProvider';
import { severityPresentation } from '../../design/rag';
import type { EnvPaths } from '../../paths';
import type { Severity } from '../../types';
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
  db: EnvPaths['db'] | null;
}

export function usePortalScope(): PortalScope {
  const { claims, paths } = useAuth();
  const isPortal = claims?.kind === 'portal';
  return {
    ready: Boolean(isPortal && paths),
    orgId: isPortal ? claims.orgId : '',
    customerId: isPortal ? claims.customerId : '',
    db: paths?.db ?? null,
  };
}

// ----------------------------------------------------------------------------
// Router URLs. RTDB paths come from useAuth().paths.db; these are the browser
// routes, kept here so a moved route changes in one place.
// ----------------------------------------------------------------------------

export const portalUrls = {
  home: '/app',
  account: '/app/account',
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
