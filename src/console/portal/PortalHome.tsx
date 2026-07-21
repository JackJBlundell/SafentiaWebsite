// ============================================================================
// PortalHome (story 2057): the customer's estate at a glance - every site they
// own with its buildings, each carrying the RAG chip and the next fire risk
// assessment review date. Read-only; every row links into the building page.
//
// Reads ride the portal rules exactly: /sites/{orgId}/{customerId} is granted
// whole (their own sites), and /buildings/{orgId}/{siteId} is granted per site
// via the sites-ownership check - so buildings are read per site, one
// subscription each, never via the staff-only org-wide root.
// ============================================================================

import { Link } from 'react-router-dom';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type { Building, Site } from '../../types';
import { PageHeader, EmptyState, ErrorNotice } from '../ui/Page';
import { Card, CardHeader } from '../ui/Card';
import { RagChip, LoadingNote, formatDate, sortByName, toEntries } from '../customers/shared';
import { usePortalScope, portalUrls } from './shared';
import styles from './PortalHome.module.css';

export function PortalHome() {
  const { ready, orgId, customerId, db } = usePortalScope();
  const sites = useRtdbQuery<Record<string, Site> | null>({
    key: keys.sites(orgId || 'none', customerId || 'none'),
    path: ready && db ? db.sites(orgId, customerId) : 'none',
    enabled: ready,
  });

  const siteEntries = sortByName(toEntries(sites.data));

  return (
    <>
      <PageHeader
        title="Your buildings"
        lede="Fire safety status and reports for every building we look after for you."
      />
      {sites.isError && (
        <ErrorNotice message="Your sites could not be loaded. Please try again." />
      )}
      {!sites.isError && sites.isLoading && (
        <LoadingNote>Loading your sites</LoadingNote>
      )}
      {!sites.isError && !sites.isLoading && siteEntries.length === 0 && (
        <EmptyState
          title="No sites yet"
          body="When your fire safety provider adds your sites and buildings, they will appear here."
        />
      )}
      <div className={styles.sites}>
        {siteEntries.map(([siteId, site]) => (
          <SiteBuildings key={siteId} siteId={siteId} site={site} />
        ))}
      </div>
    </>
  );
}

/** One site's card: its buildings with RAG and next review. Its own component
 *  because each site is its own RTDB subscription (rules grant per site). */
function SiteBuildings({ siteId, site }: { siteId: string; site: Site }) {
  const { ready, orgId, db } = usePortalScope();
  const buildings = useRtdbQuery<Record<string, Building> | null>({
    key: keys.buildings(orgId || 'none', siteId),
    path: ready && db ? db.buildings(orgId, siteId) : 'none',
    enabled: ready,
  });

  const rows = sortByName(toEntries(buildings.data));

  return (
    <Card flush>
      <div className={styles.cardHeaderPad}>
        <CardHeader title={site.name} hint={site.address} />
      </div>
      {buildings.isError && (
        <div className={styles.cardBodyPad}>
          <ErrorNotice message="This site's buildings could not be loaded." />
        </div>
      )}
      {!buildings.isError && buildings.isLoading && (
        <div className={styles.cardBodyPad}>
          <LoadingNote>Loading buildings</LoadingNote>
        </div>
      )}
      {!buildings.isError && !buildings.isLoading && rows.length === 0 && (
        <p className={styles.noBuildings}>No buildings at this site yet.</p>
      )}
      {rows.length > 0 && (
        <ul className={styles.buildingList}>
          {rows.map(([buildingId, building]) => (
            <li key={buildingId}>
              <Link
                to={portalUrls.building(siteId, buildingId)}
                className={styles.buildingRow}
              >
                <span className={styles.buildingIdentity}>
                  <span className={styles.buildingName}>{building.name}</span>
                  {building.address && (
                    <span className={styles.buildingAddress}>
                      {building.address}
                    </span>
                  )}
                </span>
                <span className={styles.buildingStatus}>
                  <RagChip level={building.riskLevel} />
                  <span className={styles.nextReview}>
                    {lastAssessedLabel(building)}
                  </span>
                  <span className={styles.nextReview}>
                    {nextReviewLabel(building)}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** The next FRA review date, from the statutory service schedule the org
 *  maintains (story 2023's fraReview key). Absence is stated plainly. */
function nextReviewLabel(building: Building): string {
  const nextDue = building.serviceSchedule?.fraReview?.nextDue;
  return nextDue ? `Next review ${formatDate(nextDue)}` : 'No review scheduled';
}

/** When the building was last assessed (story 2057 AC1): the release roll-up
 *  stamps building.lastAssessedAt. Absence is a first-class state, said
 *  plainly rather than left blank. */
function lastAssessedLabel(building: Building): string {
  return building.lastAssessedAt
    ? `Assessed ${formatDate(building.lastAssessedAt)}`
    : 'Not yet assessed';
}
