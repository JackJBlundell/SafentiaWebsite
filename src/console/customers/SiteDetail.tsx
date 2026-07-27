// ============================================================================
// SiteDetail - one site's live record and the buildings that stand on it, in
// the kit's master-and-aside layout (the same grammar as CustomerDetail and
// BuildingDetail): the buildings list works in the main column, the recorded
// site facts and the admin's actions sit pinned in the aside.
//
// Each building row carries the RAG chip from riskPresentation (label plus
// colour, never colour alone; "pending" reads "Not yet assessed"), the last
// assessed date, and its open-actions line (overdue counts in error tone,
// stated in words) so the state of a whole site is legible at a glance. The
// action counts come from the ONE org-root actions read the dashboard and
// directory already share - no per-building fan-out.
// ============================================================================

import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Button } from '../../components/Button';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type {
  Building,
  Customer,
  CustomerContact,
  OrgSettings,
  RiskLevel,
  Site,
} from '../../types';
import { RAG_CONFIG_DEFAULTS } from '../settings/ragDerivation';
import { RiskReasonBadge } from '../ui/RiskExplanation';
import { buildRiskExplanation } from '../ui/riskReasons';
import { Card, CardHeader } from '../ui/Card';
import { ComplianceGlance } from '../ui/ComplianceGlance';
import { DescriptionList, PageGrid, type DescriptionItem } from '../ui/Grid';
import { EmptyState, ErrorNotice, PageHeader } from '../ui/Page';
import {
  countOverdueActions,
  isActionOverdue,
  type ActionsRootNode,
  type BuildingRow,
} from '../reports/orgMetrics';
import { ImportDialog } from './ImportDialog';
import { OverdueBadge } from './RagSummary';
import {
  formatDate,
  LoadingNote,
  RagChip,
  sortByName,
  toEntries,
  urls,
  useOrgScope,
} from './shared';
import shared from './shared.module.css';
import styles from './SiteDetail.module.css';

/** The stored risk levels the compliance band filters this site's list to, and
 *  the human label for each filter notice. */
const RISK_LEVELS: readonly RiskLevel[] = ['high', 'medium', 'low', 'pending'];
const RISK_FILTER_LABELS: Record<RiskLevel, string> = {
  high: 'high-risk buildings',
  medium: 'medium-risk buildings',
  low: 'low-risk buildings',
  pending: 'not-yet-assessed buildings',
};

export function SiteDetail() {
  const { customerId = '', siteId = '' } = useParams<{
    customerId: string;
    siteId: string;
  }>();
  const { ready, orgId, db, isAdmin } = useOrgScope();

  // The CSV import modal. Nothing is refetched when it closes: the buildings
  // listener below is live, so imported records appear in the list by
  // themselves.
  const [importing, setImporting] = useState(false);

  // The band's tiles drill through to this site's own filtered buildings list,
  // carried in the URL (?risk=<level> / ?overdue=1) so the link is shareable.
  const [searchParams, setSearchParams] = useSearchParams();
  const riskParam = searchParams.get('risk');
  const riskFilter = RISK_LEVELS.includes(riskParam as RiskLevel)
    ? (riskParam as RiskLevel)
    : null;
  const overdueFilter = searchParams.get('overdue') === '1';

  // A same-page query change (a band tile click) does not move the viewport, so
  // the filtered list would stay below the fold. When a filter is active we
  // bring the buildings section into view; motion is dropped under
  // prefers-reduced-motion.
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
  const buildings = useRtdbQuery<Record<string, Building> | null>({
    key: keys.buildings(orgId, siteId),
    path: ready ? db!.buildings(orgId, siteId) : '',
    enabled: ready && Boolean(siteId),
  });
  // The roster, so the site contact renders from the LIVE contact record
  // rather than a stale copy.
  const contacts = useRtdbQuery<Record<string, CustomerContact> | null>({
    key: keys.customerContacts(orgId, customerId),
    path: ready ? db!.customerContacts(orgId, customerId) : '',
    enabled: ready && Boolean(customerId),
  });
  // The org-root actions node (nested by buildingId) - the dashboard's exact
  // query key, so this is served from the shared cache when it is already
  // attached, and it feeds every building row here without per-row reads.
  const actionsNode = useRtdbQuery<ActionsRootNode | null>({
    key: keys.actionsRoot(orgId),
    path: ready ? db!.actionsRoot(orgId) : '',
    enabled: ready,
  });
  // The organisation's own RAG thresholds, so each row's explanation quotes the
  // bands this org actually configured rather than the proposed defaults.
  const orgSettings = useRtdbQuery<OrgSettings | null>({
    key: keys.orgSettings(orgId),
    path: ready ? db!.orgSettings(orgId) : '',
    enabled: ready,
  });

  if (sites.isLoading) {
    return <LoadingNote>Loading site</LoadingNote>;
  }
  if (sites.isError) {
    return <ErrorNotice message="Could not load this site. Please try again." />;
  }
  const site = sites.data?.[siteId];
  if (!site) {
    return (
      <EmptyState
        title="Site not found"
        body="This site does not exist, or the link is out of date."
        action={<Button to={urls.customer(customerId)}>Back to customer</Button>}
      />
    );
  }

  const customerName = customer.data?.name ?? 'Customer';
  const buildingEntries = sortByName(toEntries(buildings.data));

  // The compliance-at-a-glance band's scope: this site's buildings, and the
  // actions that hang off them (from the SAME shared org-root reads above). Both
  // stay undefined while their backing reads attach, so the band skeletons
  // rather than showing a false zero.
  const siteBuildingRows: BuildingRow[] | undefined =
    buildings.data === undefined
      ? undefined
      : Object.entries(buildings.data ?? {}).map(([buildingId, building]) => ({
          siteId,
          buildingId,
          building,
        }));
  const siteActions =
    siteBuildingRows === undefined || actionsNode.data === undefined
      ? undefined
      : siteBuildingRows.flatMap((row) =>
          Object.values(actionsNode.data?.[row.buildingId] ?? {}),
        );

  // The buildings list, narrowed to whatever the band tile asked for.
  const filteredEntries = buildingEntries.filter(([buildingId, building]) => {
    if (riskFilter && (building.riskLevel ?? 'pending') !== riskFilter) {
      return false;
    }
    if (overdueFilter) {
      const perBuilding = Object.values(actionsNode.data?.[buildingId] ?? {});
      if (!perBuilding.some((action) => isActionOverdue(action, Date.now()))) {
        return false;
      }
    }
    return true;
  });
  const filterActive = riskFilter !== null || overdueFilter;
  const filterLabel = riskFilter
    ? RISK_FILTER_LABELS[riskFilter]
    : 'buildings with overdue actions';

  // The site contact resolves to the live contact record; the id alone is
  // never shown, and a dangling id is called out honestly rather than hidden.
  const contact = site.contactId ? contacts.data?.[site.contactId] : undefined;
  const contactValue = !site.contactId ? undefined : contact ? (
    <>
      {contact.jobTitle ? `${contact.name}, ${contact.jobTitle}` : contact.name}
      {contact.email ? ` · ${contact.email}` : ''}
      {contact.phone ? ` · ${contact.phone}` : ''}{' '}
      <Link to={urls.customer(customerId)}>View contacts</Link>
    </>
  ) : contacts.isLoading ? (
    'Loading contact'
  ) : (
    <>
      This contact is no longer in the customer&rsquo;s contact list.{' '}
      <Link to={urls.customer(customerId)}>View contacts</Link>
    </>
  );

  // Only the recorded facts; DescriptionList drops the absent ones.
  const facts: DescriptionItem[] = [
    { label: 'Address', value: site.address },
    { label: 'Site contact', value: contactValue },
    {
      label: 'Coordinates',
      value: site.geo ? `${site.geo.lat}, ${site.geo.lng}` : undefined,
    },
  ];
  const hasFacts = facts.some(
    (item) =>
      item.value !== undefined && item.value !== null && item.value !== '',
  );

  return (
    <div>
      <PageHeader
        title={site.name}
        crumbs={[
          { label: 'Customers', to: urls.customers },
          { label: customerName, to: urls.customer(customerId) },
          { label: site.name },
        ]}
      />

      <PageGrid
        aside={
          <>
            <Card>
              <CardHeader title="Site details" />
              {hasFacts ? (
                <DescriptionList items={facts} />
              ) : (
                <p className={shared.cardCopy}>No site details recorded yet.</p>
              )}
            </Card>

            {isAdmin && (
              <Card>
                <CardHeader title="Actions" />
                <Button
                  variant="secondary"
                  to={urls.siteEdit(customerId, siteId)}
                  block
                >
                  Edit site
                </Button>
              </Card>
            )}
          </>
        }
      >
        {/* The compliance-at-a-glance band, scoped to this site. Its tiles drill
            through to this site's own filtered buildings list below, consistent
            with the customer and dashboard bands. */}
        <ComplianceGlance
          buildings={siteBuildingRows}
          actions={siteActions}
          heading="Risk distribution"
          emptyNote="No buildings recorded on this site yet."
          riskHref={(level) => `${urls.site(customerId, siteId)}?risk=${level}`}
          overdueHref={`${urls.site(customerId, siteId)}?overdue=1`}
        />

        <div ref={buildingsSectionRef} id="site-buildings">
        <Card>
          <CardHeader
            title="Buildings"
            hint="What your assessors visit here. Each building carries its own risk rating, documents and service schedule."
            action={
              isAdmin && buildingEntries.length > 0 ? (
                <div className={styles.headerActions}>
                  <Button
                    variant="secondary"
                    onClick={() => setImporting(true)}
                  >
                    Import CSV
                  </Button>
                  <Button
                    variant="secondary"
                    to={urls.buildingNew(customerId, siteId)}
                  >
                    Add building
                  </Button>
                </div>
              ) : undefined
            }
          />

          {buildings.isError && (
            <ErrorNotice message="Could not load buildings. Please try again." />
          )}
          {buildings.isLoading && <LoadingNote>Loading buildings</LoadingNote>}

          {!buildings.isLoading && !buildings.isError && (
            buildingEntries.length === 0 ? (
              <>
                <p className={shared.cardCopy}>
                  No buildings recorded on this site yet. Add the first one, or
                  import a list from a spreadsheet.
                </p>
                {isAdmin && (
                  <div className={styles.emptyAction}>
                    <Button
                      variant="secondary"
                      to={urls.buildingNew(customerId, siteId)}
                    >
                      Add the first building
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
              <>
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
                {filteredEntries.length === 0 ? (
                  <p className={shared.cardCopy}>
                    No {filterLabel} on this site.
                  </p>
                ) : (
              <ul className={styles.rowList}>
                {filteredEntries.map(([buildingId, building]) => {
                  // Open + overdue counts for THIS building from the org-root
                  // read. Omitted (not zeroed) while the node is attaching.
                  const perBuilding =
                    actionsNode.data === undefined
                      ? undefined
                      : Object.values(actionsNode.data?.[buildingId] ?? {});
                  const openCount = perBuilding?.filter(
                    (action) => action.status === 'open',
                  ).length;
                  const overdue = perBuilding
                    ? countOverdueActions(perBuilding, Date.now())
                    : undefined;
                  // The row's own account of its status. The action plan IS
                  // read here (the org-root node above), so only the release
                  // record is missing; buildRiskExplanation says so rather than
                  // implying it saw everything.
                  const level = building.riskLevel ?? 'pending';
                  const explanation = buildRiskExplanation({
                    level,
                    distribution: building.ragDistribution,
                    lastAssessedAt: building.lastAssessedAt,
                    config: orgSettings.data?.ragConfig ?? RAG_CONFIG_DEFAULTS,
                    actions:
                      perBuilding === undefined
                        ? undefined
                        : {
                            hasOpenHighAction: perBuilding.some(
                              (action) =>
                                action.status === 'open' &&
                                (action.severity === 'H' ||
                                  action.lifeProtection === true),
                            ),
                            // releaseAssessment's own overdue test, not the
                            // dashboards' one-day grace, so the account matches
                            // the calculation that ran.
                            hasOverdueAction: perBuilding.some(
                              (action) =>
                                action.status === 'open' &&
                                typeof action.dueBy === 'number' &&
                                action.dueBy < Date.now(),
                            ),
                          },
                    formatDate,
                  });
                  return (
                    <li key={buildingId} className={styles.rowShell}>
                      <Link
                        to={urls.building(customerId, siteId, buildingId)}
                        className={styles.row}
                      >
                        <span className={styles.rowMain}>
                          <span className={styles.rowName}>{building.name}</span>
                          {building.address && (
                            <span className={styles.rowMeta}>
                              {building.address}
                            </span>
                          )}
                          <span className={styles.rowMeta}>
                            Last assessed:{' '}
                            {building.lastAssessedAt
                              ? formatDate(building.lastAssessedAt)
                              : 'Never'}
                          </span>
                          {openCount !== undefined && overdue !== undefined && (
                            <span className={styles.rowMeta}>
                              Open actions: {openCount}
                              {overdue.overdue > 0 && (
                                <span className={styles.overdueNote}>
                                  <OverdueBadge counts={overdue} />
                                </span>
                              )}
                            </span>
                          )}
                        </span>
                      </Link>
                      {/* The chip sits OUTSIDE the row link: it is a disclosure
                          button in its own right, and a button nested inside an
                          anchor is neither valid nor operable. Until the org's
                          thresholds have loaded there is nothing honest to
                          explain, so the plain chip stands in. */}
                      <span className={styles.rowStatus}>
                        {orgSettings.data === undefined ? (
                          <RagChip level={level} />
                        ) : (
                          <RiskReasonBadge
                            level={level}
                            explanation={explanation}
                            buildingName={building.name}
                          />
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
                )}
              </>
            )
          )}
        </Card>
        </div>
      </PageGrid>

      {importing && isAdmin && (
        <ImportDialog
          mode="buildings"
          customerId={customerId}
          siteId={siteId}
          existingNames={buildingEntries.map(([, building]) => building.name)}
          onClose={() => setImporting(false)}
        />
      )}
    </div>
  );
}
