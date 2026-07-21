// ============================================================================
// searchModel - the pure matching and grouping behind the console's global
// search. No React, no reads: it takes the already-loaded (and bounded) org
// data and a typed query, and returns grouped, capped, navigable results.
//
// Keeping this a pure module means the ranking, the group order, the caps and
// the "and N more" honesty are all unit-testable without mounting a tree or
// opening a listener, and the component beside it stays a thin shell over live
// data. Every result carries the real console URL for its entity, built from
// the same `urls` / `jobUrls` helpers the rest of the console navigates by, so
// search can never link somewhere the hierarchy does not.
// ============================================================================

import type { Building, Customer, Job, OrgMember, Site } from '../../types';
import type { BuildingRow } from '../reports/orgMetrics';
import { urls } from '../customers/shared';
import { jobUrls } from '../jobs/shared';
import { staffUrls } from '../staff/shared';

// ----------------------------------------------------------------------------
// The kinds of thing search finds, in the order they are always presented.
// ----------------------------------------------------------------------------

export type SearchKind = 'customer' | 'site' | 'building' | 'job' | 'staff';

/** Canonical group order: the estate first (Customers, Sites, Buildings, Jobs),
 *  then the people (Staff) last - a distinct domain from the property records
 *  above, and gated to roles that may read the directory. */
export const SEARCH_KIND_ORDER: readonly SearchKind[] = [
  'customer',
  'site',
  'building',
  'job',
  'staff',
] as const;

const GROUP_HEADINGS: Record<SearchKind, string> = {
  customer: 'Customers',
  site: 'Sites',
  building: 'Buildings',
  job: 'Jobs',
  staff: 'Staff',
};

/** How many results each group shows before it collapses to "and N more". */
export const GROUP_CAP = 6;

export interface SearchResultItem {
  /** Stable option id for aria-activedescendant and keyed rendering. */
  id: string;
  kind: SearchKind;
  /** The primary line: the entity's own name. */
  label: string;
  /** The quiet disambiguation line (site/customer, date/customer). May be ''. */
  detail: string;
  /** The console route this result navigates to. */
  to: string;
}

export interface SearchGroup {
  kind: SearchKind;
  heading: string;
  items: SearchResultItem[];
  /** How many further matches this group holds beyond the cap (0 when none). */
  moreCount: number;
}

export interface SearchResults {
  /** Non-empty groups only, always in SEARCH_KIND_ORDER. */
  groups: SearchGroup[];
  /** The flat, in-order list the arrow keys walk (matches the rendered rows). */
  flat: SearchResultItem[];
  /** Total matches across every group BEFORE the per-group cap. */
  matchCount: number;
}

// ----------------------------------------------------------------------------
// A site the search can see. Sites live under a customer, so the org-wide view
// is assembled per customer by the component; each row carries the ids its URL
// needs plus the record for its name.
// ----------------------------------------------------------------------------

export interface SiteRow {
  customerId: string;
  siteId: string;
  site: Site;
}

/** A job reduced to the fields search reads: its own id and the ids that place
 *  it in the hierarchy, plus the visit date for the disambiguation line. */
export interface JobRow extends Job {
  id: string;
}

/** A member the search can see: their uid (for the profile URL) and the record
 *  it matches and labels on. Fed only when the viewer may read /orgMembers; the
 *  component withholds it entirely for a viewer/finance role. */
export interface StaffRow {
  uid: string;
  member: OrgMember;
}

export interface SearchData {
  customers: Record<string, Customer> | null | undefined;
  buildings: readonly BuildingRow[];
  sites: readonly SiteRow[];
  jobs: readonly JobRow[];
  staff: readonly StaffRow[];
}

// ----------------------------------------------------------------------------
// Matching. Case-insensitive, trimmed, substring; colour is never involved, so
// nothing here depends on presentation.
// ----------------------------------------------------------------------------

/** True when `needle` (already lower-cased) appears in any provided field. */
function fieldsMatch(needle: string, ...fields: Array<string | undefined>): boolean {
  return fields.some(
    (field) => field !== undefined && field.toLowerCase().includes(needle),
  );
}

/** British long date for the job disambiguation line, e.g. "9 July 2026". A
 *  tiny local formatter (the orgMetrics CSV precedent): the model stays free of
 *  React-bearing imports so its tests need no providers. */
const jobDateFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

/** Join the parts of a disambiguation line, dropping any that are empty. */
function detailLine(...parts: Array<string | undefined>): string {
  return parts.filter((part) => part && part.length > 0).join(' - ');
}

/** Cap a group's items and report the honest overflow count. */
function capGroup(
  kind: SearchKind,
  items: SearchResultItem[],
): SearchGroup | null {
  if (items.length === 0) {
    return null;
  }
  return {
    kind,
    heading: GROUP_HEADINGS[kind],
    items: items.slice(0, GROUP_CAP),
    moreCount: Math.max(0, items.length - GROUP_CAP),
  };
}

/**
 * The one place search decides what matches and how it is grouped. `rawQuery`
 * is trimmed and lower-cased here; an empty query yields empty results (the
 * overlay shows a hint rather than the whole estate). Results within a group
 * keep the source order of their bounded input, which for jobs is the window's
 * newest-first ordering.
 */
export function buildSearchResults(
  data: SearchData,
  rawQuery: string,
): SearchResults {
  const needle = rawQuery.trim().toLowerCase();
  if (needle.length === 0) {
    return { groups: [], flat: [], matchCount: 0 };
  }

  const customerName = (id: string): string =>
    data.customers?.[id]?.name ?? id;
  const siteName = (customerId: string, siteId: string): string | undefined =>
    data.sites.find(
      (row) => row.customerId === customerId && row.siteId === siteId,
    )?.site.name;
  const buildingName = (siteId: string, buildingId: string): string | undefined =>
    data.buildings.find(
      (row) => row.siteId === siteId && row.buildingId === buildingId,
    )?.building.name;

  // Customers.
  const customerItems: SearchResultItem[] = Object.entries(data.customers ?? {})
    .filter(([, customer]: [string, Customer]) =>
      fieldsMatch(needle, customer.name, customer.address),
    )
    .map(([customerId, customer]) => ({
      id: `customer-${customerId}`,
      kind: 'customer' as const,
      label: customer.name,
      detail: customer.address ?? '',
      to: urls.customer(customerId),
    }));

  // Sites.
  const siteItems: SearchResultItem[] = data.sites
    .filter((row) => fieldsMatch(needle, row.site.name, row.site.address))
    .map((row) => ({
      id: `site-${row.customerId}-${row.siteId}`,
      kind: 'site' as const,
      label: row.site.name,
      detail: detailLine(customerName(row.customerId)),
      to: urls.site(row.customerId, row.siteId),
    }));

  // Buildings.
  const buildingItems: SearchResultItem[] = data.buildings
    .filter((row) => fieldsMatch(needle, row.building.name, row.building.address))
    .map((row) => {
      const building: Building = row.building;
      return {
        id: `building-${row.siteId}-${row.buildingId}`,
        kind: 'building' as const,
        label: building.name,
        detail: detailLine(
          siteName(building.customerId, row.siteId),
          customerName(building.customerId),
        ),
        to: urls.building(building.customerId, row.siteId, row.buildingId),
      };
    });

  // Jobs. A job has no name of its own, so it is matched (and labelled) by its
  // building, and disambiguated by its visit date and customer.
  const jobItems: SearchResultItem[] = data.jobs
    .filter((job) => {
      const label = buildingName(job.siteId, job.buildingId);
      const date = jobDateFormat.format(job.scheduledFor);
      return fieldsMatch(needle, label, customerName(job.customerId), date);
    })
    .map((job) => ({
      id: `job-${job.id}`,
      kind: 'job' as const,
      label: buildingName(job.siteId, job.buildingId) ?? 'Assessment visit',
      detail: detailLine(
        jobDateFormat.format(job.scheduledFor),
        customerName(job.customerId),
      ),
      to: jobUrls.job(job.id),
    }));

  // Staff. Matched (and labelled) by name, disambiguated by email.
  const staffItems: SearchResultItem[] = data.staff
    .filter((row) => fieldsMatch(needle, row.member.name, row.member.email))
    .map((row) => ({
      id: `staff-${row.uid}`,
      kind: 'staff' as const,
      label: row.member.name,
      detail: row.member.email,
      to: staffUrls.profile(row.uid),
    }));

  const byKind: Record<SearchKind, SearchResultItem[]> = {
    customer: customerItems,
    site: siteItems,
    building: buildingItems,
    job: jobItems,
    staff: staffItems,
  };

  const matchCount = SEARCH_KIND_ORDER.reduce(
    (sum, kind) => sum + byKind[kind].length,
    0,
  );

  const groups: SearchGroup[] = [];
  const flat: SearchResultItem[] = [];
  for (const kind of SEARCH_KIND_ORDER) {
    const group = capGroup(kind, byKind[kind]);
    if (group) {
      groups.push(group);
      flat.push(...group.items);
    }
  }

  return { groups, flat, matchCount };
}
