// ============================================================================
// PortalHome (story 2057): the customer's fire safety position, in the order a
// duty-holder needs it.
//
//   1. The headline counts - how many buildings, how many at high risk, how
//      many reviews overdue, how many never assessed.
//   2. "Needs your attention" - the buildings behind those counts, worst first,
//      each with the plain-language REASON it is listed. This is the answer to
//      "what am I being asked to do".
//   3. The estate itself, site by site, for browsing rather than triage.
//
// Reads ride the portal rules exactly: /sites/{orgId}/{customerId} is granted
// whole (their own sites), and /buildings/{orgId}/{siteId} is granted per site
// via the sites-ownership check - so buildings are read per site, one
// subscription each, never via the staff-only org-wide root.
//
// Those per-site subscriptions are the ONLY listeners on this screen, and they
// are LIFTED: a `SiteBuildingsFeed` owns each one and reports its rows to this
// component, which then renders both the triage sections and the site cards
// from one collected picture. Nothing here fans a listener out per BUILDING
// (reports and actions are per-building nodes in the rules, so summarising them
// on this screen would mean exactly the N+1 subscription CONVENTIONS 2 forbids;
// they live on the building page, where one building means one listener).
// ============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type { Building, RiskLevel, Site } from '../../types';
import { PageHeader, EmptyState, ErrorNotice } from '../ui/Page';
import { Card, CardHeader, StatCard } from '../ui/Card';
import { CardGrid } from '../ui/Grid';
import { RagChip, LoadingNote, formatDate, sortByName, toEntries } from '../customers/shared';
import {
  usePortalScope,
  usePortalOrgIdentity,
  portalUrls,
  portalReadStatus,
  type PortalReadStatus,
} from './shared';
import styles from './PortalHome.module.css';

const DAY_MS = 86_400_000;
/** How far ahead a statutory review counts as "coming up" rather than simply
 *  scheduled. Two months is enough notice for a landlord to book the work. */
const REVIEW_SOON_DAYS = 60;

/** What one site's building subscription currently knows. A site with no
 *  buildings reports `ready` with no rows - an empty node is an answer, not a
 *  subscription that has yet to arrive. */
interface SiteBuildings {
  rows: [string, Building][];
  status: PortalReadStatus;
}

/** A building with the site it belongs to, so a triage row can name both. */
interface BuildingRow {
  siteId: string;
  siteName: string;
  buildingId: string;
  building: Building;
}

/** Why a building is on the attention list. The order of this array IS the
 *  triage order: worst first.
 *
 *  "Never assessed" is deliberately NOT here. A building with no fire risk
 *  assessment is waiting on the ASSESSOR, not on the customer, so putting it
 *  under "Needs your attention" would imply the customer has a task they do not.
 *  It is surfaced instead as a neutral "awaiting assessment" status (below). */
const ATTENTION_REASONS = ['highRisk', 'reviewOverdue', 'reviewDueSoon'] as const;
type AttentionReason = (typeof ATTENTION_REASONS)[number];

const ATTENTION_LABELS: Record<AttentionReason, string> = {
  highRisk: 'High risk',
  reviewOverdue: 'Review overdue',
  reviewDueSoon: 'Review due soon',
};

/** Every reason that applies to a building right now, worst first. */
function attentionReasons(building: Building, now: number): AttentionReason[] {
  const reasons: AttentionReason[] = [];
  if (building.riskLevel === 'high') {
    reasons.push('highRisk');
  }
  const nextDue = building.serviceSchedule?.fraReview?.nextDue;
  if (nextDue !== undefined && nextDue < now) {
    reasons.push('reviewOverdue');
  }
  if (
    nextDue !== undefined &&
    nextDue >= now &&
    nextDue - now <= REVIEW_SOON_DAYS * DAY_MS
  ) {
    reasons.push('reviewDueSoon');
  }
  return reasons;
}

/** A building whose first fire risk assessment has not been carried out yet.
 *  Reported as a neutral status, never as a customer to-do: the action sits
 *  with the assessing organisation. */
function isAwaitingAssessment(building: Building): boolean {
  return building.riskLevel === 'pending' || building.lastAssessedAt === undefined;
}

export function PortalHome() {
  const { ready, orgId, customerId, db } = usePortalScope();
  const { name: orgName } = usePortalOrgIdentity();
  const sites = useRtdbQuery<Record<string, Site> | null>({
    key: keys.sites(orgId || 'none', customerId || 'none'),
    path: ready && db ? db.sites(orgId, customerId) : 'none',
    enabled: ready,
  });

  const siteEntries = useMemo(
    () => sortByName(toEntries(sites.data)),
    [sites.data],
  );

  // Collected from the per-site feeds below. Keyed by siteId, and read only for
  // sites that are still in `siteEntries`, so a removed site needs no prune.
  const [bySite, setBySite] = useState<Record<string, SiteBuildings>>({});
  const collect = useCallback((siteId: string, state: SiteBuildings) => {
    setBySite((current) => ({ ...current, [siteId]: state }));
  }, []);

  const buildings = useMemo<BuildingRow[]>(
    () =>
      siteEntries.flatMap(([siteId, site]) =>
        (bySite[siteId]?.rows ?? []).map(([buildingId, building]) => ({
          siteId,
          siteName: site.name,
          buildingId,
          building,
        })),
      ),
    [siteEntries, bySite],
  );

  const sitesStatus = portalReadStatus(sites);

  // Counts appear only once every site has ANSWERED, so a tile never shows a
  // number that is about to grow. `undefined` renders StatCard's skeleton.
  //
  // "Answered" deliberately includes both an empty site and a site whose read
  // failed: neither is going to tell us any more than it already has, so
  // waiting on them is waiting forever. A failed site is called out separately
  // below, so the counts are never quietly wrong.
  const settled =
    sitesStatus === 'ready' &&
    siteEntries.every(([siteId]) => {
      const state = bySite[siteId];
      return state !== undefined && state.status !== 'loading';
    });
  const partial = siteEntries.some(
    ([siteId]) => bySite[siteId]?.status === 'failed',
  );

  const now = Date.now();
  const flagged = buildings
    .map((row) => ({ row, reasons: attentionReasons(row.building, now) }))
    .filter((entry) => entry.reasons.length > 0)
    .sort(
      (a, b) =>
        ATTENTION_REASONS.indexOf(a.reasons[0]) -
        ATTENTION_REASONS.indexOf(b.reasons[0]),
    );

  const countOf = (reason: AttentionReason): number | undefined =>
    settled
      ? flagged.filter((entry) => entry.reasons.includes(reason)).length
      : undefined;

  // Counted independently of the attention list, because awaiting assessment is
  // a status the customer is not expected to act on, not a flag against them.
  const awaitingAssessment = settled
    ? buildings.filter((row) => isAwaitingAssessment(row.building)).length
    : undefined;

  return (
    <>
      <PageHeader
        title="Your fire safety position"
        lede={
          orgName
            ? `${orgName} carries out the fire risk assessments for the buildings below. Start with anything that needs your attention.`
            : 'Fire safety status and reports for every building we look after for you.'
        }
      />
      {sitesStatus === 'failed' && (
        <ErrorNotice message="Your sites could not be loaded. Please try again." />
      )}
      {sitesStatus === 'loading' && <LoadingNote>Loading your sites</LoadingNote>}
      {sitesStatus === 'ready' && siteEntries.length === 0 && (
        <EmptyState
          title="Nothing to show yet"
          body="Your fire safety provider has not added any sites or buildings to your account yet. As soon as they do, everything they look after for you will appear here."
        />
      )}

      {/* The subscriptions. They render nothing; every section below is drawn
          from what they report. */}
      {siteEntries.map(([siteId]) => (
        <SiteBuildingsFeed key={siteId} siteId={siteId} onResult={collect} />
      ))}

      {siteEntries.length > 0 && (
        <>
          <section className={styles.summary} aria-label="Fire safety summary">
            <CardGrid min={200}>
              <StatCard
                label="Buildings"
                value={settled ? buildings.length : undefined}
                hint={
                  siteEntries.length === 1
                    ? 'at one site'
                    : `across ${siteEntries.length} sites`
                }
              />
              <StatCard
                label="High risk"
                value={countOf('highRisk')}
                hint="need remedial work"
                tone="danger"
              />
              <StatCard
                label="Reviews overdue"
                value={countOf('reviewOverdue')}
                hint="past their review date"
                tone="warning"
              />
              <StatCard
                label="Awaiting assessment"
                value={awaitingAssessment}
                hint="your assessor will carry these out"
              />
            </CardGrid>
            {partial && (
              <p className={styles.partialNote}>
                Some buildings could not be loaded, so these counts may be
                incomplete. Please refresh the page.
              </p>
            )}
          </section>

          {settled && (
            <AttentionCard flagged={flagged} total={buildings.length} />
          )}

          <h2 className={styles.sectionHeading}>Your sites</h2>
          <div className={styles.sites}>
            {siteEntries.map(([siteId, site]) => (
              <SiteCard
                key={siteId}
                siteId={siteId}
                site={site}
                state={bySite[siteId]}
              />
            ))}
          </div>
        </>
      )}
    </>
  );
}

/**
 * One site's building subscription, lifted out of the presentation. It renders
 * nothing: its job is to own the listener the rules force to be per-site and
 * hand the result up, so the page can summarise across sites without any
 * component attaching a second listener to the same node.
 */
function SiteBuildingsFeed({
  siteId,
  onResult,
}: {
  siteId: string;
  onResult: (siteId: string, state: SiteBuildings) => void;
}) {
  const { ready, orgId, db } = usePortalScope();
  const buildings = useRtdbQuery<Record<string, Building> | null>({
    key: keys.buildings(orgId || 'none', siteId),
    path: ready && db ? db.buildings(orgId, siteId) : 'none',
    enabled: ready,
  });

  const { data } = buildings;
  const status = portalReadStatus(buildings);

  useEffect(() => {
    onResult(siteId, { rows: sortByName(toEntries(data)), status });
  }, [siteId, data, status, onResult]);

  return null;
}

/** The triage list: every building with something wrong with it, worst first,
 *  each saying WHY in words. When nothing is flagged the card says so plainly
 *  rather than disappearing, so a reader can tell "all clear" from "not
 *  loaded". */
function AttentionCard({
  flagged,
  total,
}: {
  flagged: { row: BuildingRow; reasons: AttentionReason[] }[];
  total: number;
}) {
  // Sites on record but not a single building yet. Saying so is the whole
  // point: a page of zeros with no explanation reads as a broken portal.
  if (total === 0) {
    return (
      <Card>
        <CardHeader
          title="No buildings on record yet"
          hint="Your fire safety provider has not added any buildings to your sites yet. Once they do, each building's fire safety status, reports and action plan will appear here."
        />
      </Card>
    );
  }

  if (flagged.length === 0) {
    return (
      <Card>
        <CardHeader
          title="Nothing needs your attention"
          hint="No building is at high risk or overdue for review. Any building awaiting its first assessment is with your assessor, not you."
        />
      </Card>
    );
  }

  return (
    <Card flush>
      <div className={styles.cardHeaderPad}>
        <CardHeader
          title="Needs your attention"
          hint="The buildings to look at first. Open one to read its report and action plan."
        />
      </div>
      <ul className={styles.attentionList}>
        {flagged.map(({ row, reasons }) => (
          <li key={`${row.siteId}/${row.buildingId}`}>
            <Link
              to={portalUrls.building(row.siteId, row.buildingId)}
              className={styles.attentionRow}
            >
              <span className={styles.buildingIdentity}>
                <span className={styles.buildingName}>{row.building.name}</span>
                <span className={styles.buildingAddress}>{row.siteName}</span>
              </span>
              <span className={styles.buildingStatus}>
                <RagChip level={row.building.riskLevel} />
                {reasons.map((reason) => (
                  <span key={reason} className={styles.reasonChip}>
                    {ATTENTION_LABELS[reason]}
                  </span>
                ))}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** A one-glance read of a whole site, derived ENTIRELY from the building rows
 *  that site's feed already delivered - no second read is taken to build it.
 *  Every building lands in exactly one bucket, so `total` is the four counts
 *  summed, and the estate can never be double-counted. */
interface SiteSummary {
  total: number;
  high: number;
  medium: number;
  low: number;
  /** Awaiting its first assessment: the task sits with the assessor, so this is
   *  a neutral status, deliberately not a risk grade. */
  awaiting: number;
  /** The highest risk actually present, for the header status chip. `pending`
   *  when nothing has been assessed yet - never green for an un-assessed site. */
  worst: RiskLevel;
  /** One plain-language line stating where the site stands. */
  headline: string;
  reviewsOverdue: number;
  reviewsDueSoon: number;
}

/** The distribution bar / breakdown buckets, worst first. The segment class maps
 *  to the FIXED RAG safety tokens (red/amber/green) plus a neutral for awaiting,
 *  so the colours only ever reinforce the count and label beside them. */
const SITE_BUCKETS = [
  { key: 'high', label: 'high risk', seg: 'segHigh' },
  { key: 'medium', label: 'medium risk', seg: 'segMedium' },
  { key: 'low', label: 'low risk', seg: 'segLow' },
  { key: 'awaiting', label: 'awaiting assessment', seg: 'segAwait' },
] as const;

/** Fold a site's already-loaded buildings into its summary. `now` is passed in
 *  so the review thresholds match the rest of the page to the millisecond. */
function summariseSite(rows: [string, Building][], now: number): SiteSummary {
  let high = 0;
  let medium = 0;
  let low = 0;
  let awaiting = 0;
  let reviewsOverdue = 0;
  let reviewsDueSoon = 0;
  for (const [, building] of rows) {
    // Awaiting takes precedence over the raw grade: an un-assessed building must
    // never be counted as low-risk just because its grade defaults that way.
    if (isAwaitingAssessment(building)) {
      awaiting += 1;
    } else if (building.riskLevel === 'high') {
      high += 1;
    } else if (building.riskLevel === 'medium') {
      medium += 1;
    } else {
      low += 1;
    }
    // Same thresholds the attention logic uses (attentionReasons), so the site
    // card and the triage list never disagree about what is overdue.
    const nextDue = building.serviceSchedule?.fraReview?.nextDue;
    if (nextDue !== undefined && nextDue < now) {
      reviewsOverdue += 1;
    } else if (
      nextDue !== undefined &&
      nextDue - now <= REVIEW_SOON_DAYS * DAY_MS
    ) {
      reviewsDueSoon += 1;
    }
  }
  const total = rows.length;
  const worst: RiskLevel =
    high > 0 ? 'high' : medium > 0 ? 'medium' : low > 0 ? 'low' : 'pending';
  return {
    total,
    high,
    medium,
    low,
    awaiting,
    worst,
    headline: siteHeadline({ total, high, medium, low, awaiting }),
    reviewsOverdue,
    reviewsDueSoon,
  };
}

/** The site's position in one sentence: the worst risk present, or that it is
 *  awaiting its first assessment, or that everything is assessed and low. */
function siteHeadline(s: {
  total: number;
  high: number;
  medium: number;
  low: number;
  awaiting: number;
}): string {
  const assessed = s.high + s.medium + s.low;
  if (assessed === 0) {
    return s.total === 1
      ? 'Awaiting first assessment'
      : `All ${s.total} buildings awaiting first assessment`;
  }
  const awaitingTail =
    s.awaiting > 0 ? `, ${s.awaiting} awaiting assessment` : '';
  if (s.high > 0) {
    return s.total === 1
      ? 'High risk, remedial work needed'
      : `${s.high} of ${s.total} at high risk${awaitingTail}`;
  }
  if (s.medium > 0) {
    return s.total === 1
      ? 'Medium risk'
      : `${s.medium} of ${s.total} at medium risk${awaitingTail}`;
  }
  if (s.awaiting > 0) {
    return `Low risk so far${awaitingTail}`;
  }
  return s.total === 1 ? 'Assessed, low risk' : 'All buildings assessed, low risk';
}

/** The summary band under a site's header: its position in a sentence, the
 *  proportional RAG mix (only when there is more than one building to be
 *  proportional about), and the exact count behind each grade. Every colour is
 *  paired with its count and word, so it is never the sole carrier. */
function SiteSummaryBand({ summary }: { summary: SiteSummary }) {
  const present = SITE_BUCKETS.filter((bucket) => summary[bucket.key] > 0);
  const reviewNote = [
    summary.reviewsOverdue > 0
      ? `${summary.reviewsOverdue} ${summary.reviewsOverdue === 1 ? 'review' : 'reviews'} overdue`
      : null,
    summary.reviewsDueSoon > 0
      ? `${summary.reviewsDueSoon} due soon`
      : null,
  ].filter((part): part is string => part !== null);

  return (
    <div className={styles.siteSummary}>
      <p className={styles.siteHeadline}>{summary.headline}</p>
      {summary.total > 1 && (
        <div aria-hidden="true" className={styles.riskBar}>
          {present.map((bucket) => (
            <span
              key={bucket.key}
              className={`${styles.seg} ${styles[bucket.seg]}`}
              style={{ flexGrow: summary[bucket.key] }}
            />
          ))}
        </div>
      )}
      <ul className={styles.riskLegend}>
        {present.map((bucket) => (
          <li key={bucket.key} className={styles.riskLegendItem}>
            <span
              aria-hidden="true"
              className={`${styles.swatch} ${styles[bucket.seg]}`}
            />
            <span className={styles.riskLegendText}>
              {summary[bucket.key]} {bucket.label}
            </span>
          </li>
        ))}
      </ul>
      {reviewNote.length > 0 && (
        <p className={styles.siteMeta}>{reviewNote.join(' · ')}</p>
      )}
    </div>
  );
}

/** The next-review cell for a building row. A review that is overdue or due
 *  soon is raised to a labelled chip (the SAME thresholds and wording as the
 *  attention list), so it reads as a flag rather than a quiet date; otherwise
 *  the scheduled date, or its plainly-stated absence, sits muted. The word
 *  carries the meaning - the chip is neutral, never a RAG colour. */
function ReviewCell({ building, now }: { building: Building; now: number }) {
  const nextDue = building.serviceSchedule?.fraReview?.nextDue;
  if (nextDue === undefined) {
    return (
      <span className={styles.reviewCell}>
        <span className={styles.nextReview}>No review scheduled</span>
      </span>
    );
  }
  if (nextDue < now) {
    return (
      <span className={styles.reviewCell}>
        <span className={styles.reasonChip}>Review overdue</span>
        <span className={styles.nextReview}>Was due {formatDate(nextDue)}</span>
      </span>
    );
  }
  if (nextDue - now <= REVIEW_SOON_DAYS * DAY_MS) {
    return (
      <span className={styles.reviewCell}>
        <span className={styles.reasonChip}>Review due soon</span>
        <span className={styles.nextReview}>Due {formatDate(nextDue)}</span>
      </span>
    );
  }
  return (
    <span className={styles.reviewCell}>
      <span className={styles.nextReview}>Next review {formatDate(nextDue)}</span>
    </span>
  );
}

/** One site's card: a headline status and risk breakdown for the whole site,
 *  then its buildings with RAG, last assessed and next review. Everything here
 *  is derived from the rows that site's feed already delivered - the card takes
 *  no read of its own, so a page of sites is still one listener per site. */
function SiteCard({
  siteId,
  site,
  state,
}: {
  siteId: string;
  site: Site;
  state: SiteBuildings | undefined;
}) {
  const rows = state?.rows ?? [];
  const ready = state?.status === 'ready';
  // Derived once from the already-loaded rows; no listener is attached here.
  const summary =
    ready && rows.length > 0 ? summariseSite(rows, Date.now()) : undefined;
  const now = Date.now();

  return (
    <Card flush>
      <div className={styles.cardHeaderPad}>
        <CardHeader
          as="h3"
          title={site.name}
          hint={site.address}
          action={summary ? <RagChip level={summary.worst} /> : undefined}
        />
      </div>
      {summary && <SiteSummaryBand summary={summary} />}
      {state?.status === 'failed' && (
        <div className={styles.cardBodyPad}>
          <ErrorNotice message="This site's buildings could not be loaded. Please try again." />
        </div>
      )}
      {(state === undefined || state.status === 'loading') && (
        <div className={styles.cardBodyPad}>
          <LoadingNote>Loading buildings</LoadingNote>
        </div>
      )}
      {state?.status === 'ready' && rows.length === 0 && (
        <p className={styles.noBuildings}>
          No buildings have been added to this site yet.
        </p>
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
                  <ReviewCell building={building} now={now} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** When the building was last assessed (story 2057 AC1): the release roll-up
 *  stamps building.lastAssessedAt. Absence is a first-class state, said
 *  plainly rather than left blank. */
function lastAssessedLabel(building: Building): string {
  return building.lastAssessedAt
    ? `Assessed ${formatDate(building.lastAssessedAt)}`
    : 'Not yet assessed';
}
