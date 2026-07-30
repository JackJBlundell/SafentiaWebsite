// ============================================================================
// CustomerDetail - the ORGANISATION profile. Stats across the estate, the
// people (ContactsPanel, where portal access now lives per contact), and the
// sites, with the organisation facts and admin actions pinned in the aside.
// Everything is live from RTDB, so a rename or an archive elsewhere is
// reflected without a refresh.
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Button } from '../../components/Button';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type {
  Building,
  Customer,
  ManageCustomerInput,
  ManageCustomerResult,
  RiskLevel,
  Site,
} from '../../types';
import { Card, CardHeader } from '../ui/Card';
import { ComplianceGlance } from '../ui/ComplianceGlance';
import { DataTable, type Column } from '../ui/DataTable';
import { DescriptionList, PageGrid } from '../ui/Grid';
import { EmptyState, ErrorNotice, PageHeader } from '../ui/Page';
import { useCallable } from '../ui/useCallable';
import {
  countBuildingsByRisk,
  flattenBuildings,
  isActionOverdue,
  type ActionsRootNode,
  type BuildingsRootNode,
} from '../reports/orgMetrics';
import { ContactsPanel } from './ContactsPanel';
import { ImportDialog } from './ImportDialog';
import { RagSummary } from './RagSummary';
import {
  formatDate,
  LoadingNote,
  RagChip,
  sortByName,
  StatusBadge,
  toEntries,
  urls,
  useOrgScope,
} from './shared';
import shared from './shared.module.css';
import styles from './CustomerDetail.module.css';

/** The stored risk levels the compliance band can filter the buildings list to,
 *  and the human label for each filter notice. Kept in one place so the tile
 *  link, the notice and the filter predicate cannot drift. */
const RISK_LEVELS: readonly RiskLevel[] = ['high', 'medium', 'low', 'pending'];
const RISK_FILTER_LABELS: Record<RiskLevel, string> = {
  high: 'high-risk buildings',
  medium: 'medium-risk buildings',
  low: 'low-risk buildings',
  pending: 'not-yet-assessed buildings',
};

type SiteRow = { id: string; site: Site };
type BuildingsBySite = Record<string, Record<string, Building> | null>;
type EstateBuildingRow = {
  siteId: string;
  siteName: string;
  buildingId: string;
  building: Building;
};

/** The building's next FRA review (story 2036 AC2): the scheduled date in
 *  British English, an honest fallback when none is scheduled, and the error
 *  tone - with the word "lapsed", never colour alone - once the review date
 *  has gone by (the same lapsed reading as orgMetrics' upcomingReviews). */
function NextReviewCell({
  building,
  now,
}: {
  building: Building;
  now: number;
}) {
  const nextDue = building.serviceSchedule?.fraReview?.nextDue;
  if (nextDue === undefined) {
    return <span className={styles.noReview}>No review scheduled</span>;
  }
  if (nextDue < now) {
    return (
      <span className={styles.reviewLapsed}>
        {formatDate(nextDue)} (lapsed)
      </span>
    );
  }
  return <span>{formatDate(nextDue)}</span>;
}

export function CustomerDetail() {
  const { customerId = '' } = useParams<{ customerId: string }>();
  const { ready, orgId, db, isAdmin } = useOrgScope();

  // The compliance band's tiles drill through to a filtered view of THIS
  // customer's buildings, carried in the URL so the link is shareable and the
  // Back button works. ?risk=<level> narrows the buildings list to that stored
  // level; ?overdue=1 narrows it to buildings carrying an overdue action.
  // The CSV import modal. Nothing is refetched when it closes: the sites and
  // per-site buildings listeners below are live, so imported records appear in
  // the lists by themselves.
  const [importing, setImporting] = useState(false);

  const [searchParams, setSearchParams] = useSearchParams();
  const riskParam = searchParams.get('risk');
  const riskFilter = RISK_LEVELS.includes(riskParam as RiskLevel)
    ? (riskParam as RiskLevel)
    : null;
  const overdueFilter = searchParams.get('overdue') === '1';

  // A same-page query change (a band tile click) does not move the viewport, so
  // the filtered list stays below the fold and the click can read as a no-op.
  // When a filter is active we bring the buildings section into view; motion is
  // dropped under prefers-reduced-motion.
  const buildingsSectionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (riskFilter === null && !overdueFilter) {
      return;
    }
    const section = buildingsSectionRef.current;
    if (!section || typeof section.scrollIntoView !== 'function') {
      return;
    }
    const reduceMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    section.scrollIntoView({
      behavior: reduceMotion ? 'auto' : 'smooth',
      block: 'start',
    });
  }, [riskFilter, overdueFilter]);

  const customer = useRtdbQuery<Customer | null>({
    key: keys.customer(orgId, customerId),
    path: ready ? db!.customer(orgId, customerId) : '',
    enabled: ready && Boolean(customerId),
  });
  const sites = useRtdbQuery<Record<string, Site> | null>({
    key: keys.sites(orgId, customerId),
    path: ready ? db!.sites(orgId, customerId) : '',
    enabled: ready && Boolean(customerId),
  });

  // The two org-root roll-up reads feed the compliance-at-a-glance band,
  // SCOPED to this customer. They share the dashboard's and directory's exact
  // cache keys (keys.buildingsRoot / keys.actionsRoot), so this attaches no new
  // subscription where one already exists; we simply filter each to the
  // customer (buildings carry their own customerId; actions nest by buildingId).
  const buildingsRoot = useRtdbQuery<BuildingsRootNode | null>({
    key: keys.buildingsRoot(orgId),
    path: ready ? db!.buildingsRoot(orgId) : '',
    enabled: ready,
  });
  const actionsRoot = useRtdbQuery<ActionsRootNode | null>({
    key: keys.actionsRoot(orgId),
    path: ready ? db!.actionsRoot(orgId) : '',
    enabled: ready,
  });
  const scopedBuildings =
    buildingsRoot.data === undefined
      ? undefined
      : flattenBuildings(buildingsRoot.data).filter(
          (row) => row.building.customerId === customerId,
        );
  const scopedActions =
    scopedBuildings === undefined || actionsRoot.data === undefined
      ? undefined
      : scopedBuildings.flatMap((row) =>
          Object.values(actionsRoot.data?.[row.buildingId] ?? {}),
        );

  // Buildings per site, for the stat row. Hooks cannot run in a loop, so each
  // site gets a render-nothing probe component that subscribes and reports up.
  // The fanout is BOUNDED: one listener per site of ONE customer (a handful),
  // and each shares its cache entry (keys.buildings) with SiteDetail, so
  // navigating deeper costs nothing extra.
  const [buildingsBySite, setBuildingsBySite] = useState<BuildingsBySite>({});
  const onSiteBuildings = useCallback(
    (siteId: string, data: Record<string, Building> | null) => {
      setBuildingsBySite((prev) => (prev[siteId] === data ? prev : { ...prev, [siteId]: data }));
    },
    [],
  );

  const siteRows: SiteRow[] = useMemo(
    () => sortByName(toEntries(sites.data)).map(([id, site]) => ({ id, site })),
    [sites.data],
  );

  // Every building across the estate, flattened from the SAME per-site probe
  // data as the stat band - no extra subscription. Each row carries its next
  // FRA review date (story 2036 AC2).
  const buildingRows: EstateBuildingRow[] = useMemo(
    () =>
      siteRows
        .flatMap((row) =>
          toEntries(buildingsBySite[row.id]).map(([buildingId, building]) => ({
            siteId: row.id,
            siteName: row.site.name,
            buildingId,
            building,
          })),
        )
        .sort((a, b) =>
          (a.building.name ?? '').localeCompare(b.building.name ?? '', 'en-GB'),
        ),
    [siteRows, buildingsBySite],
  );

  const rag = useMemo(() => {
    const counts = { high: 0, medium: 0, low: 0, pending: 0, total: 0 };
    for (const row of siteRows) {
      for (const [, building] of toEntries(buildingsBySite[row.id])) {
        counts.total += 1;
        counts[building.riskLevel ?? 'pending'] += 1;
      }
    }
    return counts;
  }, [siteRows, buildingsBySite]);

  // Buildings carrying at least one overdue action, from the shared org-root
  // actions read - the set the ?overdue=1 tile filters the list to.
  const overdueBuildingIds = useMemo(() => {
    const ids = new Set<string>();
    const now = Date.now();
    for (const [buildingId, actions] of Object.entries(actionsRoot.data ?? {})) {
      if (Object.values(actions).some((action) => isActionOverdue(action, now))) {
        ids.add(buildingId);
      }
    }
    return ids;
  }, [actionsRoot.data]);

  // The buildings list, narrowed to whatever the band tile asked for. With no
  // filter it is the whole estate; a filter that matches nothing renders an
  // honest note rather than hiding the card.
  const filteredBuildingRows = buildingRows.filter((row) => {
    if (riskFilter && (row.building.riskLevel ?? 'pending') !== riskFilter) {
      return false;
    }
    if (overdueFilter && !overdueBuildingIds.has(row.buildingId)) {
      return false;
    }
    return true;
  });
  const filterActive = riskFilter !== null || overdueFilter;
  const filterLabel = riskFilter
    ? RISK_FILTER_LABELS[riskFilter]
    : 'buildings with overdue actions';

  if (customer.isLoading) {
    return <LoadingNote>Loading customer</LoadingNote>;
  }
  if (customer.isError) {
    return <ErrorNotice message="Could not load this customer. Please try again." />;
  }
  if (!customer.data) {
    return (
      <EmptyState
        title="Customer not found"
        body="This customer does not exist, or the link is out of date."
        action={<Button to={urls.customers}>Back to customers</Button>}
      />
    );
  }

  const record = customer.data;

  const siteColumns: Array<Column<SiteRow>> = [
    {
      header: 'Name',
      cell: (row) => <span className={styles.cellName}>{row.site.name}</span>,
    },
    {
      header: 'Address',
      cell: (row) => row.site.address ?? '',
    },
    {
      header: 'Buildings',
      desktopOnly: true,
      // The per-site risk strip, from the SAME per-site probe data the stat
      // band above rolls up - no extra subscription for this column. Blank
      // while a probe attaches; "No buildings" once it lands empty.
      cell: (row) => {
        const buildings = buildingsBySite[row.id];
        if (buildings === undefined) return null;
        const buildingRows = toEntries(buildings).map(([buildingId, building]) => ({
          siteId: row.id,
          buildingId,
          building: { ...building, riskLevel: building.riskLevel ?? 'pending' },
        }));
        return <RagSummary counts={countBuildingsByRisk(buildingRows)} />;
      },
    },
  ];

  const now = Date.now();
  const buildingColumns: Array<Column<EstateBuildingRow>> = [
    {
      header: 'Building',
      cell: (row) => (
        <span className={styles.cellName}>{row.building.name}</span>
      ),
    },
    {
      header: 'Site',
      cell: (row) => row.siteName,
      desktopOnly: true,
    },
    {
      header: 'Risk',
      cell: (row) => <RagChip level={row.building.riskLevel ?? 'pending'} />,
      desktopOnly: true,
    },
    {
      header: 'Next review',
      cell: (row) => <NextReviewCell building={row.building} now={now} />,
    },
  ];

  return (
    <div className={styles.root}>
      {siteRows.map((row) => (
        <SiteBuildingsProbe
          key={row.id}
          orgId={orgId}
          siteId={row.id}
          path={ready ? db!.buildings(orgId, row.id) : ''}
          enabled={ready}
          onData={onSiteBuildings}
        />
      ))}

      <PageHeader
        title={record.name}
        lede="Customer organisation"
        crumbs={[{ label: 'Customers', to: urls.customers }, { label: record.name }]}
        badges={
          <>
            <span className={styles.countBadge}>
              {siteRows.length} {siteRows.length === 1 ? 'site' : 'sites'}
            </span>
            <span className={styles.countBadge}>
              {rag.total} {rag.total === 1 ? 'building' : 'buildings'}
            </span>
          </>
        }
      />

      <PageGrid
        aside={
          <>
            {/* The organisation's facts and the actions that act on them live in
                one card: they are the same subject, and splitting them left a
                near-empty second card pushing everything below it further down. */}
            <Card>
              <CardHeader title="Organisation" />
              {record.photoUrl && (
                <img
                  src={record.photoUrl}
                  alt={`${record.name} logo`}
                  className={styles.orgImage}
                />
              )}
              <DescriptionList
                items={[
                  { label: 'Address', value: record.address },
                  { label: 'Switchboard email', value: record.email },
                  { label: 'Phone', value: record.phone },
                  // Only shown once set: an open-ended contract is the norm, and
                  // an empty row would imply the field had been forgotten.
                  ...(record.contractEndDate
                    ? [
                        {
                          label: 'Contract ends',
                          value: `${formatDate(record.contractEndDate)}${
                            record.status === 'active' ? ' - archives automatically' : ''
                          }`,
                        },
                      ]
                    : []),
                  { label: 'Status', value: <StatusBadge status={record.status} /> },
                ]}
              />
              {isAdmin && (
                <div className={styles.actions}>
                  <Button variant="secondary" to={urls.customerEdit(customerId)}>
                    Edit organisation
                  </Button>
                  {record.status === 'archived' ? (
                    <RestoreControl customerId={customerId} name={record.name} />
                  ) : (
                    <ArchiveControl customerId={customerId} name={record.name} />
                  )}
                </div>
              )}
            </Card>

            <ContactsPanel customerId={customerId} />
          </>
        }
      >
        {/* The compliance-at-a-glance band, scoped to this customer's estate.
            Its tiles drill through to this customer's own filtered buildings
            list below (?risk=<level> / ?overdue=1), so the band is clickable
            and consistent with every other page it appears on. */}
        <ComplianceGlance
          buildings={scopedBuildings}
          actions={scopedActions}
          heading="Risk distribution"
          emptyNote="No buildings recorded for this customer yet."
          riskHref={(level) => `${urls.customer(customerId)}?risk=${level}`}
          overdueHref={`${urls.customer(customerId)}?overdue=1`}
        />

        <Card flush={siteRows.length > 0}>
          <CardHeader
            title="Sites"
            hint="The locations this customer occupies. Each site holds the buildings you assess."
            action={
              isAdmin && siteRows.length > 0 ? (
                <div className={styles.headerActions}>
                  <Button
                    variant="secondary"
                    onClick={() => setImporting(true)}
                  >
                    Import CSV
                  </Button>
                  <Button variant="secondary" to={urls.siteNew(customerId)}>
                    Add site
                  </Button>
                </div>
              ) : undefined
            }
          />
          {siteRows.length === 0 ? (
            <>
              <p className={shared.cardCopy}>
                No sites yet. Add the first one to start recording buildings, or
                import a whole estate from a spreadsheet.
              </p>
              {isAdmin && (
                <div className={styles.emptyAction}>
                  <Button variant="secondary" to={urls.siteNew(customerId)}>
                    Add the first site
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => setImporting(true)}
                  >
                    Import CSV
                  </Button>
                </div>
              )}
            </>
          ) : (
            <DataTable
              label="Sites"
              columns={siteColumns}
              rows={siteRows}
              rowKey={(row) => row.id}
              rowHref={(row) => urls.site(customerId, row.id)}
            />
          )}
        </Card>

        <div ref={buildingsSectionRef} id="customer-buildings">
        {buildingRows.length > 0 && (
          <Card flush>
            <CardHeader
              title="Buildings"
              hint="Every building across this customer's sites, with its current risk and next FRA review."
            />
            {filterActive && (
              <div className={styles.filterNotice}>
                <span>Showing {filterLabel}</span>
                <Button
                  variant="ghost"
                  onClick={() => setSearchParams({}, { replace: true })}
                >
                  Clear filter
                </Button>
              </div>
            )}
            {filteredBuildingRows.length === 0 ? (
              <p className={shared.cardCopy}>
                No {filterLabel} for this customer.
              </p>
            ) : (
              <DataTable
                label="Buildings"
                columns={buildingColumns}
                rows={filteredBuildingRows}
                rowKey={(row) => `${row.siteId}/${row.buildingId}`}
                rowHref={(row) =>
                  urls.building(customerId, row.siteId, row.buildingId)
                }
              />
            )}
          </Card>
        )}
        </div>
      </PageGrid>

      {importing && isAdmin && (
        <ImportDialog
          mode="sites"
          customerId={customerId}
          existingNames={siteRows.map((row) => row.site.name)}
          onClose={() => setImporting(false)}
        />
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// One live buildings listener per site, reported up for the stat row. Renders
// nothing; unmounts (and detaches) with the page.
// ----------------------------------------------------------------------------

function SiteBuildingsProbe({
  orgId,
  siteId,
  path,
  enabled,
  onData,
}: {
  orgId: string;
  siteId: string;
  path: string;
  enabled: boolean;
  onData: (siteId: string, data: Record<string, Building> | null) => void;
}) {
  const buildings = useRtdbQuery<Record<string, Building> | null>({
    key: keys.buildings(orgId, siteId),
    path,
    enabled,
  });
  // Reporting during render is unsafe; the effect keeps parent state in step
  // with the live data instead.
  const { data } = buildings;
  useEffect(() => {
    if (data !== undefined) {
      onData(siteId, data);
    }
  }, [siteId, data, onData]);
  return null;
}

// ----------------------------------------------------------------------------
// Archive / restore - each a two-step confirm, never a bare one-click flip.
// ----------------------------------------------------------------------------

function ArchiveControl({ customerId, name }: { customerId: string; name: string }) {
  const manageCustomer = useCallable<ManageCustomerInput, ManageCustomerResult>(
    'manageCustomer',
  );
  const [confirming, setConfirming] = useState(false);

  const onArchive = async () => {
    const result = await manageCustomer.call({ action: 'archive', customerId });
    if (result) {
      setConfirming(false);
    }
  };

  if (!confirming) {
    return (
      <>
        <Button variant="secondary" onClick={() => setConfirming(true)}>
          Archive customer
        </Button>
        <p className={shared.note}>
          Archiving ends the relationship: this customer leaves your active
          lists, their people can no longer sign in to the portal, and they stop
          receiving review reminders. Nothing is deleted - their sites, buildings
          and assessment history stay intact, and restoring them gives their
          people their access back.
        </p>
      </>
    );
  }

  return (
    <>
      <p className={shared.cardCopy}>
        Archive {name}? Their people lose portal access immediately and their
        review reminders stop. Their buildings and history remain, and restoring
        them returns the access this withdraws.
      </p>
      {manageCustomer.error && <ErrorNotice message={manageCustomer.error} />}
      <div className={shared.formActions}>
        <Button
          variant="secondary"
          disabled={manageCustomer.pending}
          onClick={() => void onArchive()}
        >
          {manageCustomer.pending ? 'Archiving' : 'Confirm archive'}
        </Button>
        <Button
          variant="ghost"
          disabled={manageCustomer.pending}
          onClick={() => {
            manageCustomer.clearError();
            setConfirming(false);
          }}
        >
          Cancel
        </Button>
      </div>
    </>
  );
}

function RestoreControl({ customerId, name }: { customerId: string; name: string }) {
  const manageCustomer = useCallable<ManageCustomerInput, ManageCustomerResult>(
    'manageCustomer',
  );
  const [confirming, setConfirming] = useState(false);

  const onRestore = async () => {
    const result = await manageCustomer.call({ action: 'restore', customerId });
    if (result) {
      setConfirming(false);
    }
  };

  if (!confirming) {
    return (
      <>
        <Button variant="secondary" onClick={() => setConfirming(true)}>
          Restore customer
        </Button>
        <p className={shared.note}>
          Restoring returns this customer to active lists. Their sites,
          buildings and history are exactly as they were left.
        </p>
      </>
    );
  }

  return (
    <>
      <p className={shared.cardCopy}>Restore {name}? They return to active lists.</p>
      {manageCustomer.error && <ErrorNotice message={manageCustomer.error} />}
      <div className={shared.formActions}>
        <Button
          variant="secondary"
          disabled={manageCustomer.pending}
          onClick={() => void onRestore()}
        >
          {manageCustomer.pending ? 'Restoring' : 'Confirm restore'}
        </Button>
        <Button
          variant="ghost"
          disabled={manageCustomer.pending}
          onClick={() => {
            manageCustomer.clearError();
            setConfirming(false);
          }}
        >
          Cancel
        </Button>
      </div>
    </>
  );
}
