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
import {
  activityTargetUrl,
  humaniseAction,
  isReleaseAction,
} from './lib/humaniseActivity';
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

/** One bounded activity window feeds BOTH cards below: the eight newest events
 *  verbatim, and the newest five release events filtered from the same rows.
 *  Releases are sparse among general activity, hence the wider window; one
 *  subscription, two honest views of it. */
const ACTIVITY_WINDOW = 100;
const RECENT_EVENT_COUNT = 8;
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
  // isReleaseAction, not an exact string match: releaseAssessment appends a
  // "(manual risk: ...)" detail when the assessor overrode the derived band,
  // and those releases belong in this card too.
  const recentReleases = activity.data
    ?.filter((row) => isReleaseAction(row.action))
    .slice(0, RECENT_RELEASE_COUNT);

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
              hint={`Assessments released, from the newest ${ACTIVITY_WINDOW} recorded events.`}
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
            {recentReleases !== undefined && recentReleases.length > 0 && (
              <ul className={styles.activityList}>
                {/* The trail records the assessment id as each row's target;
                    there is no console URL for a released assessment yet, so
                    the target stays text rather than a dead link
                    (activityTargetUrl encodes the same rule). */}
                {recentReleases.map((row) => (
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
        </CardGrid>
      </PageGrid>
    </div>
  );
}
