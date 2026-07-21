// ============================================================================
// Shared pieces for the Customers area: the org scope hook every screen reads,
// URL builders for the customer -> site -> building hierarchy, the RAG chip and
// status badge, and the small formatting helpers. One definition each, so the
// list, detail and form screens cannot drift apart.
// ============================================================================

import { useAuth } from '../../auth/AuthProvider';
import { useTheme } from '../../design/ThemeProvider';
import { riskPresentation } from '../../design/rag';
import { EmptyState } from '../ui/Page';
import type { EnvPaths } from '../../paths';
import type { GeoPoint, MemberStatus, RiskLevel } from '../../types';
import styles from './shared.module.css';

// ----------------------------------------------------------------------------
// Org scope - who is looking, and where their data lives.
// ----------------------------------------------------------------------------

export interface OrgScope {
  /** False only in the brief window before claims resolve; screens keep their
   *  queries disabled until this is true. */
  ready: boolean;
  orgId: string;
  db: EnvPaths['db'] | null;
  /** CREATE/EDIT controls render only for admins; everyone else browses. */
  isAdmin: boolean;
}

export function useOrgScope(): OrgScope {
  const { claims, paths } = useAuth();
  return {
    ready: Boolean(claims && paths),
    orgId: claims?.orgId ?? '',
    db: paths?.db ?? null,
    isAdmin: claims?.roles.admin === true,
  };
}

// ----------------------------------------------------------------------------
// Router URLs for the hierarchy. RTDB paths come from useAuth().paths.db; these
// are the browser routes, kept here so a moved route changes in one place.
// ----------------------------------------------------------------------------

export const urls = {
  customers: '/app/customers',
  customerNew: '/app/customers/new',
  customer: (customerId: string) => `/app/customers/${customerId}`,
  customerEdit: (customerId: string) => `/app/customers/${customerId}/edit`,
  siteNew: (customerId: string) => `/app/customers/${customerId}/sites/new`,
  site: (customerId: string, siteId: string) =>
    `/app/customers/${customerId}/sites/${siteId}`,
  siteEdit: (customerId: string, siteId: string) =>
    `/app/customers/${customerId}/sites/${siteId}/edit`,
  buildingNew: (customerId: string, siteId: string) =>
    `/app/customers/${customerId}/sites/${siteId}/buildings/new`,
  building: (customerId: string, siteId: string, buildingId: string) =>
    `/app/customers/${customerId}/sites/${siteId}/buildings/${buildingId}`,
  buildingEdit: (customerId: string, siteId: string, buildingId: string) =>
    `/app/customers/${customerId}/sites/${siteId}/buildings/${buildingId}/edit`,
} as const;

// ----------------------------------------------------------------------------
// Record helpers - RTDB lists arrive as object maps (or null when empty).
// ----------------------------------------------------------------------------

export function toEntries<T>(
  record: Record<string, T> | null | undefined,
): [string, T][] {
  return record ? Object.entries(record) : [];
}

export function sortByName<T extends { name?: string }>(
  entries: [string, T][],
): [string, T][] {
  return [...entries].sort((a, b) =>
    (a[1].name ?? '').localeCompare(b[1].name ?? '', 'en-GB'),
  );
}

// ----------------------------------------------------------------------------
// Formatting and validation helpers.
// ----------------------------------------------------------------------------

const dateFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

/** British long date from epoch millis, e.g. "9 July 2026". */
export function formatDate(millis: number): string {
  return dateFormat.format(millis);
}

/** Deliberately permissive: catch obvious typos without rejecting valid
 *  addresses. The server revalidates. */
export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** The point a typed latitude/longitude pair describes, or null when the pair
 *  is incomplete or out of range. Location forms keep the pair as text so it
 *  can be half-typed, and use this to decide what the map may pin; the submit
 *  handler is what explains a bad pair to the user. */
export function toGeoPoint(lat: string, lng: string): GeoPoint | null {
  const latText = lat.trim();
  const lngText = lng.trim();
  if (latText === '' || lngText === '') {
    return null;
  }
  const latValue = Number(latText);
  const lngValue = Number(lngText);
  if (!Number.isFinite(latValue) || latValue < -90 || latValue > 90) {
    return null;
  }
  if (!Number.isFinite(lngValue) || lngValue < -180 || lngValue > 180) {
    return null;
  }
  return { lat: latValue, lng: lngValue };
}

// ----------------------------------------------------------------------------
// Small presentational pieces.
// ----------------------------------------------------------------------------

/** The RAG chip: fixed safety colour plus label and icon, so colour is never
 *  the sole carrier. `pending` renders as "Not yet assessed". */
export function RagChip({ level }: { level: RiskLevel }) {
  const { theme } = useTheme();
  const rag = riskPresentation(theme, level);
  return (
    <span
      className={styles.ragChip}
      style={{ color: rag.color, background: rag.surface }}
    >
      <span aria-hidden="true">{rag.icon}</span>
      {rag.label}
    </span>
  );
}

const STATUS_LABELS: Record<MemberStatus, string> = {
  active: 'Active',
  locked: 'Locked',
  archived: 'Archived',
};

export function StatusBadge({ status }: { status: MemberStatus }) {
  return (
    <span
      className={
        status === 'active' ? styles.statusBadgeActive : styles.statusBadgeMuted
      }
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

/** Quiet, announced loading line used while a live query attaches. */
export function LoadingNote({ children }: { children: string }) {
  return (
    <p role="status" className={styles.loading}>
      {children}
    </p>
  );
}

/** The calm panel a non-admin sees on a direct URL to a create/edit form. */
export function NoAccessPanel() {
  return (
    <EmptyState
      title="You do not have access to this page"
      body="Only administrators can add or change customer records. You can still browse every customer, site and building."
    />
  );
}
