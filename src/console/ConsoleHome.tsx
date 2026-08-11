// ============================================================================
// ConsoleHome - the organisation compliance dashboard (story 2035, FR-E19).
//
// Honest by design: every tile is backed by a live read the signed-in role is
// actually allowed to make. The org-root nodes this page rolls up (/buildings,
// /actions, /activity) are readable by EVERY org role per database.rules.json,
// so the whole dashboard renders for a viewer or finance member; only the
// actor-name resolution read (/orgMembers) is role-gated, exactly as before,
// and degrades to raw uids rather than a dead tile.
//
// The numbers are derived in src/console/reports/orgMetrics.ts (pure, shared
// with the finance reports so the two surfaces cannot disagree), and risk
// levels are the STORED levels the release pipeline derived via the shared
// ragDerivation model - this page presents, it never re-derives.
// ============================================================================

import { Link } from 'react-router-dom';
import {
  equalTo,
  limitToLast,
  orderByChild,
  query,
} from 'firebase/database';
import { useAuth } from '../auth/AuthProvider';
import { Button } from '../components/Button';
import { keys } from '../query/keys';
import { useRtdbQuery, type RtdbQueryBuilder } from '../query/useRtdbQuery';
import { ORG_ROLES } from '../types';
import type {
  ActivityEntry,
  Assessment,
  OrgMember,
  OrgProfile,
  OrgRole,
} from '../types';
import { Card, CardHeader } from './ui/Card';
import { CardGrid, PageGrid } from './ui/Grid';
import { ComplianceGlance } from './ui/ComplianceGlance';
import { PageHeader } from './ui/Page';
import { SkeletonRows } from './ui/Skeleton';
import { RagChip, formatDate, urls } from './customers/shared';
import { activityTargetUrl, humaniseAction } from './lib/humaniseActivity';
import {
  ReportLink,
  releasedAt,
  templateLabel,
  useCustomerName,
  useReleaseBuilding,
} from './validation/releaseShared';
import {
  flattenActions,
  flattenBuildings,
  upcomingReviews,
  REVIEW_WINDOW_DAYS,
  type ActionsRootNode,
  type BuildingsRootNode,
} from './reports/orgMetrics';
import { actorName as resolveActorName } from './lib/actorName';
import styles from './ConsoleHome.module.css';

/** Human labels for the role claims. The claim keys are API vocabulary; the
 *  page speaks to a person. */
const ROLE_LABELS: Record<OrgRole, string> = {
  admin: 'Administrator',
  assessor: 'Assessor',
  auditor: 'Auditor',
  finance: 'Finance',
  viewer: 'Viewer',
};

/** The bounded activity window behind the recent-activity feed. */
const ACTIVITY_WINDOW = 100;
const RECENT_EVENT_COUNT = 8;

/** Recent releases are read from the RELEASED ASSESSMENTS themselves, not from
 *  the activity trail: an ActivityEntry carries only an actor, a verb and an
 *  assessment id, which cannot answer "what went out, for whom, under which
 *  template". The subscription is the released list's own indexed query
 *  (orderByChild('status') + equalTo('released')) with a small limitToLast.
 *
 *  The window is wider than the number of rows shown because limitToLast on a
 *  status query bounds by KEY order, and an assessment's key is minted when the
 *  assessment starts, not when it is released; taking a slightly deeper slice
 *  and then sorting by release time makes "the five most recent releases"
 *  actually true, while keeping the payload bounded (each assessment carries a
 *  full template snapshot). */
const RELEASE_WINDOW = 25;
const RECENT_RELEASE_COUNT = 5;

interface ActivityRow extends ActivityEntry {
  id: string;
}

/** Newest-first activity rows. The bounded query pulls the latest ACTIVITY_WINDOW
 *  by `at`; we order explicitly by `at` (descending) rather than relying on
 *  snapshot iteration, because the selector runs off the cached raw value, which
 *  carries no iteration order. */
function selectActivityRows(value: unknown): ActivityRow[] {
  const node = (value as Record<string, ActivityEntry> | null) ?? {};
  return Object.entries(node)
    .map(([id, entry]) => ({ id, ...entry }))
    .sort((a, b) => b.at - a.at);
}

/** Stable builder (module scope) for the bounded activity window. */
const buildActivityWindow: RtdbQueryBuilder = (node) =>
  query(node, orderByChild('at'), limitToLast(ACTIVITY_WINDOW));

/** Stable builder for the bounded released-assessments window. */
const buildReleaseWindow: RtdbQueryBuilder = (node) =>
  query(
    node,
    orderByChild('status'),
    equalTo('released'),
    limitToLast(RELEASE_WINDOW),
  );

interface ReleaseRow extends Assessment {
  id: string;
}

/** Newest release first, the same ordering the released list uses, so the two
 *  surfaces can never disagree about what "most recent" means. */
function selectReleaseRows(value: unknown): ReleaseRow[] {
  const node = (value as Record<string, Assessment> | null) ?? {};
  return Object.entries(node)
    .map(([id, assessment]) => ({ id, ...assessment }))
    .sort((a, b) => releasedAt(b) - releasedAt(a))
    .slice(0, RECENT_RELEASE_COUNT);
}

/** British date, 24-hour time, for the tooltip: "12 Jun 2026, 14:03". */
const dateTimeFormat = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const relativeFormat = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' });

const TIME_DIVISIONS: Array<{ amount: number; unit: Intl.RelativeTimeFormatUnit }> = [
  { amount: 60, unit: 'seconds' },
  { amount: 60, unit: 'minutes' },
  { amount: 24, unit: 'hours' },
  { amount: 7, unit: 'days' },
  { amount: 4.34524, unit: 'weeks' },
  { amount: 12, unit: 'months' },
];

/** "2 hours ago" from epoch millis; the exact timestamp goes on the title. */
function relativeTime(at: number, now: number): string {
  let duration = (at - now) / 1000;
  for (const division of TIME_DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return relativeFormat.format(Math.round(duration), division.unit);
    }
    duration /= division.amount;
  }
  return relativeFormat.format(Math.round(duration), 'years');
}

/** One feed row, phrased for people: "<actor> <phrase>" as the primary line
 *  (via the shared humaniser, so this card and the activity log can never
 *  phrase an event differently), with the target - and any audit detail the
 *  Functions appended - as the secondary line. Customer and job targets link
 *  to their real console routes; everything else stays text (see
 *  activityTargetUrl for the route-by-route reasoning). */
function ActivityFeedRow({
  row,
  actor,
  now,
}: {
  row: ActivityRow;
  actor: string;
  now: number;
}) {
  const { phrase, detail } = humaniseAction(row.action);
  const targetUrl = activityTargetUrl(row.action, row.target);
  return (
    <li className={styles.activityRow}>
      <div className={styles.activityText}>
        <span className={styles.activityAction}>
          {actor} {phrase}
        </span>
        <span className={styles.activityTarget}>
          {targetUrl ? (
            <Link to={targetUrl} className={styles.activityTargetLink}>
              {row.target}
            </Link>
          ) : (
            row.target
          )}
          {detail ? ` · ${detail}` : ''}
        </span>
      </div>
      <time
        className={styles.activityTime}
        dateTime={new Date(row.at).toISOString()}
        title={dateTimeFormat.format(row.at)}
      >
        {relativeTime(row.at, now)}
      </time>
    </li>
  );
}

/**
 * One released assessment, told in full: which BUILDING went out, for which
 * CUSTOMER, under which TEMPLATE (and its standard where the template declares
 * one), when, and by whom - with the report PDF reachable from the row itself.
 *
 * The building name links to the building's own record, which every org role
 * can reach and which holds the complete assessment history. Until the job
 * resolves its site there is no honest building URL, so the name renders as
 * plain text rather than a link that would 404; a dangling building or customer
 * record renders its raw id, never a blank.
 */
function ReleaseRow({
  row,
  releaser,
  now,
}: {
  row: ReleaseRow;
  releaser: string;
  now: number;
}) {
  const { building, siteId } = useReleaseBuilding(row.jobId, row.buildingId);
  const customerName = useCustomerName(row.customerId);
  const buildingName = building?.name ?? row.buildingId;
  const at = releasedAt(row);
  const href = siteId
    ? urls.building(row.customerId, siteId, row.buildingId)
    : null;

  return (
    <li className={styles.releaseRow}>
      <div className={styles.releaseText}>
        {href ? (
          <Link to={href} className={styles.releaseLink}>
            {buildingName}
          </Link>
        ) : (
          <span className={styles.releaseName}>{buildingName}</span>
        )}
        <span className={styles.releaseMeta}>
          {customerName} · {templateLabel(row.templateSnapshot)}
        </span>
        <span className={styles.releaseMeta}>
          Released{' '}
          <time
            dateTime={new Date(at).toISOString()}
            title={dateTimeFormat.format(at)}
          >
            {relativeTime(at, now)}
          </time>{' '}
          by {releaser}
        </span>
      </div>
      <div className={styles.releaseAction}>
        <ReportLink
          buildingId={row.buildingId}
          assessmentId={row.id}
          subject={buildingName}
        />
      </div>
    </li>
  );
}

/** Role-aware quick actions: each entry points at a route (and query) that
 *  genuinely exists for that role - /app/validation is gated to auditor and
 *  admin, /app/reports to finance and admin, and the ?risk=/?overdue= filters
 *  are the customer directory's own vocabulary. A member with several roles
 *  gets the FIRST matching set (admins keep their original three). */
const QUICK_ACTIONS: Array<{
  role: OrgRole;
  actions: Array<{ label: string; to: string }>;
}> = [
  {
    role: 'admin',
    actions: [
      { label: 'New customer', to: urls.customerNew },
      { label: 'Schedule a job', to: '/app/jobs/new' },
      { label: 'Validation queue', to: '/app/validation' },
    ],
  },
  {
    role: 'auditor',
    actions: [
      { label: 'Validation queue', to: '/app/validation' },
      { label: 'View activity log', to: '/app/activity' },
    ],
  },
  {
    role: 'assessor',
    actions: [
      { label: 'Jobs board', to: '/app/jobs' },
      { label: 'High-risk customers', to: `${urls.customers}?risk=high` },
    ],
  },
  {
    role: 'finance',
    actions: [
      { label: 'Reports', to: '/app/reports' },
      { label: 'Customers with overdue actions', to: `${urls.customers}?overdue=1` },
    ],
  },
  {
    role: 'viewer',
    actions: [
      { label: 'High-risk customers', to: `${urls.customers}?risk=high` },
      { label: 'Customers with overdue actions', to: `${urls.customers}?overdue=1` },
    ],
  },
];

/** How many review rows the card lists before deferring to the buildings
 *  themselves; the horizon (60 days) bounds the list, this bounds the card. */
const REVIEW_ROW_LIMIT = 8;

export function ConsoleHome() {
  const { user, claims, paths } = useAuth();
  const orgId = claims?.orgId ?? '';
  const enabled = Boolean(claims && paths);

  // The shell's BrandedConsole already subscribed to this key, so this read is
  // served from the shared cache - no second listener is attached for the
  // same key/path pair once one exists.
  const profile = useRtdbQuery<OrgProfile | null>({
    key: keys.orgProfile(orgId),
    path: paths ? paths.db.orgProfile(orgId) : '',
    enabled,
  });

  // The two org-root roll-up reads. Rules grant both whole nodes to every org
  // role, so no tile here needs a role gate. ONE subscription each over the
  // whole estate - see the scale note in orgMetrics.ts.
  const buildingsNode = useRtdbQuery<BuildingsRootNode | null>({
    key: keys.buildingsRoot(orgId),
    path: paths ? paths.db.buildingsRoot(orgId) : '',
    enabled,
  });
  const actionsNode = useRtdbQuery<ActionsRootNode | null>({
    key: keys.actionsRoot(orgId),
    path: paths ? paths.db.actionsRoot(orgId) : '',
    enabled,
  });

  // database.rules.json grants /orgMembers to admin, assessor and auditor
  // ONLY: for a viewer or finance member the listener would be denied and
  // retried forever, so the subscription is gated and the activity card falls
  // back to raw uids (exactly as ActivityPage does).
  const canReadMembers =
    claims?.roles.admin === true ||
    claims?.roles.assessor === true ||
    claims?.roles.auditor === true;
  const membersQuery = useRtdbQuery<Record<string, OrgMember> | null>({
    key: keys.orgMembers(orgId),
    path: paths ? paths.db.orgMembers(orgId) : '',
    enabled: enabled && canReadMembers,
  });
  const members = membersQuery.data;
  const actorName = (uid: string): string =>
    resolveActorName(members, uid, members !== undefined);

  // The releases list sits behind the validation area's auditor/admin gate.
  const canReachReleases =
    claims?.roles.auditor === true || claims?.roles.admin === true;

  // ActivityPage's bounded, indexed window; recent events and recent releases
  // are both cut from these rows.
  const activity = useRtdbQuery<ActivityRow[]>({
    key: keys.activity(orgId, ACTIVITY_WINDOW),
    path: paths ? paths.db.activity(orgId) : '',
    select: selectActivityRows,
    enabled,
    build: buildActivityWindow,
  });

  // The releases card's own indexed, bounded subscription. Its own cache key
  // (window size included), so it never clobbers the released list's deeper
  // window over the same node.
  const releases = useRtdbQuery<ReleaseRow[]>({
    key: keys.assessmentsByStatusWindow(orgId, 'released', RELEASE_WINDOW),
    path: paths ? paths.db.assessments(orgId) : '',
    select: selectReleaseRows,
    enabled,
    build: buildReleaseWindow,
  });

  // Greet by first name where one exists; the old greeting card's content now
  // lives in this header lede.
  const firstName = user?.displayName?.trim().split(/\s+/)[0];
  const roles = claims ? ORG_ROLES.filter((role) => claims.roles[role]) : [];
  const orgName = profile.data?.name ?? claims?.orgId;
  const ledeParts = [orgName, roles.map((role) => ROLE_LABELS[role]).join(', ')]
    .filter(Boolean)
    .join(' · ');

  // Derivations tolerate the not-yet-loaded state: a quiet placeholder, never
  // an invented zero. `undefined` data means "still attaching"; a loaded-but-
  // empty node is a real, reportable zero.
  const now = Date.now();
  const buildingRows =
    buildingsNode.data === undefined
      ? undefined
      : flattenBuildings(buildingsNode.data);
  const actionRows =
    actionsNode.data === undefined ? undefined : flattenActions(actionsNode.data);
  const reviews = buildingRows ? upcomingReviews(buildingRows, now) : undefined;

  const recentEvents = activity.data?.slice(0, RECENT_EVENT_COUNT);
  const recentReleases = releases.data;

  // The first quick-action set whose role the member holds; admins keep their
  // original three. A member with no matching set gets no card, not filler.
  const quickActions = QUICK_ACTIONS.find(
    (set) => claims?.roles[set.role] === true,
  )?.actions;

  return (
    <div>
      <PageHeader
        title={firstName ? `Hello, ${firstName}` : 'Hello'}
        lede={ledeParts || 'An overview of your organisation on Safentia.'}
      />

      {/* The onboarding checklist now floats bottom-right from the ConsoleShell
          (home/FloatingGettingStarted), so it follows the admin across every
          console page rather than living only on this dashboard. */}
      <PageGrid
        aside={
          <>
            {quickActions && (
              <Card>
                <CardHeader title="Quick actions" />
                <div className={styles.quickActions}>
                  {quickActions.map((action) => (
                    <Button
                      key={action.to}
                      variant="secondary"
                      to={action.to}
                      block
                    >
                      {action.label}
                    </Button>
                  ))}
                </div>
              </Card>
            )}

            <Card>
              <CardHeader
                title="Recent activity"
                action={
                  <Button variant="ghost" to="/app/activity">
                    View all
                  </Button>
                }
              />
              {recentEvents === undefined && (
                <SkeletonRows rows={4} label="Loading recent activity" />
              )}
              {recentEvents !== undefined && recentEvents.length === 0 && (
                <p className={styles.quietNote}>
                  No activity has been recorded yet.
                </p>
              )}
              {recentEvents !== undefined && recentEvents.length > 0 && (
                <ul className={styles.activityList}>
                  {recentEvents.map((row) => (
                    <ActivityFeedRow
                      key={row.id}
                      row={row}
                      actor={actorName(row.actorUid)}
                      now={now}
                    />
                  ))}
                </ul>
              )}
            </Card>
          </>
        }
      >
        {/* --- The compliance-at-a-glance band: buildings by stored risk, then
               the action-plan escalations. There is no filtered buildings list
               page yet, so the risk tiles drill through to the customer
               directory FILTERED to the customers holding that problem
               (?risk=<level>), and the overdue tiles to the customers with
               overdue actions (?overdue=1); the directory rolls up the same two
               org-root reads, so the numbers agree by construction. The band
               itself is the shared ComplianceGlance, fed the estate's building
               and action rows. --- */}
        <ComplianceGlance
          buildings={buildingRows}
          actions={actionRows}
          riskHref={(level) => `${urls.customers}?risk=${level}`}
          overdueHref={`${urls.customers}?overdue=1`}
        />

        {/* --- The two-column band: what needs attention next, and what has
               just gone out of the door. --- */}
        <CardGrid min={340}>
          <Card>
            <CardHeader
              title="Upcoming reviews"
              hint={`FRA reviews lapsed or due within ${REVIEW_WINDOW_DAYS} days.`}
            />
            {reviews === undefined && (
              <SkeletonRows rows={3} label="Loading review dates" />
            )}
            {reviews !== undefined && reviews.length === 0 && (
              <p className={styles.quietNote}>
                No FRA reviews are lapsed or due within the next{' '}
                {REVIEW_WINDOW_DAYS} days.
              </p>
            )}
            {reviews !== undefined && reviews.length > 0 && (
              <ul className={styles.reviewList}>
                {reviews.slice(0, REVIEW_ROW_LIMIT).map((row) => (
                  <li key={row.buildingId} className={styles.reviewRow}>
                    <div className={styles.reviewText}>
                      <Link
                        to={urls.building(
                          row.building.customerId,
                          row.siteId,
                          row.buildingId,
                        )}
                        className={styles.reviewLink}
                      >
                        {row.building.name}
                      </Link>
                      <span
                        className={
                          row.lapsed ? styles.reviewDateLapsed : styles.reviewDate
                        }
                      >
                        {row.lapsed ? 'Lapsed ' : 'Due '}
                        {formatDate(row.nextDue)}
                      </span>
                    </div>
                    <RagChip level={row.building.riskLevel} />
                  </li>
                ))}
              </ul>
            )}
            {reviews !== undefined && reviews.length > REVIEW_ROW_LIMIT && (
              <p className={styles.quietNote}>
                And {reviews.length - REVIEW_ROW_LIMIT} more within the window.
              </p>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Recent releases"
              hint={`The last ${RECENT_RELEASE_COUNT} assessments released to customers, with their reports.`}
              action={
                // The full releases list lives in the auditor-gated validation
                // area, so the affordance is offered only to the roles that can
                // reach it - a viewer would land on the access panel otherwise.
                canReachReleases ? (
                  <Button variant="ghost" to="/app/validation/released">
                    View all
                  </Button>
                ) : undefined
              }
            />
            {recentReleases === undefined && (
              <SkeletonRows rows={3} label="Loading releases" />
            )}
            {recentReleases !== undefined && recentReleases.length === 0 && (
              <p className={styles.quietNote}>
                No assessments have been released recently.
              </p>
            )}
            {releases.isError && (
              <p className={styles.quietNote}>
                Could not load recent releases. Please try again.
              </p>
            )}
            {recentReleases !== undefined && recentReleases.length > 0 && (
              <ul className={styles.releaseList}>
                {recentReleases.map((row) => (
                  <ReleaseRow
                    key={row.id}
                    row={row}
                    releaser={
                      row.workflow?.releasedBy
                        ? actorName(row.workflow.releasedBy)
                        : 'an account no longer recorded'
                    }
                    now={now}
                  />
                ))}
              </ul>
            )}
          </Card>
        </CardGrid>
      </PageGrid>
    </div>
  );
}
