// ============================================================================
// deadlineReminders (scheduled) - the sweep for the two dated commitments the
// platform previously set and then never chased.
//
// Every morning at 07:45 UK time (after the job and FRA-review sweeps, so the
// three morning nudges arrive in a predictable order) we walk both environment
// roots and look for:
//
//   1. INFORMATION REQUESTS. An assessment sitting at `infoRequired` whose open
//      InfoRequest carries a `dueBy`. The assigned assessor is reminded, in-app
//      (plus best-effort push) and by email. One notice per ASSESSMENT, not per
//      question: a batch shares one deadline and one conversation, so four
//      flagged questions must not become four notifications. The earliest open
//      deadline on the assessment is the one that governs.
//
//   2. ACTIONS. An open `Action` with a `dueBy`. The remedial work is the
//      responsible party's to arrange, so the EMAIL goes to them, resolved
//      exactly as manageAction's assignment email resolves it: through the
//      action's own `responsibleContactId`, never by matching a name against
//      the building's party (which chased only the building's default and left
//      everyone else's overdue work unchased). Responsible parties are
//      customer contacts, not org members: they have no in-app inbox and no
//      preferences node, so the IN-APP notice goes to the org's active admins,
//      who are the people who can actually chase it inside Safentia. Admins get
//      ONE digest per morning covering every action that matched, not one notice
//      per action: a per-action fan-out would flood the inbox on a ladder day
//      and could exhaust the org's monthly notification quota, which
//      sendNotification enforces by silently dropping everything after the cap.
//
// Reminder ladders differ because the deadlines do. An information request runs
// for INFO_REQUEST_DUE_DAYS (7) by default, so a 60/30/7 ladder would never
// fire: it gets 3 and 1 days out. An action's default window is 7, 30 or 90
// days by severity (DUE_WINDOW_DAYS), so it gets 30, 7 and 1. Both ladders are
// org-configurable (OrgSettings.infoRequestReminderDays / actionReminderDays)
// against the shared rules in lib/reminderSchedules, with those built-in
// defaults as the fallback whenever an org has not set one - or has stored one
// the rules reject, which repairs rather than skips, so a single bad settings
// node cannot abort a cross-org sweep. Each half also has its own master switch,
// because an org that wants its assessors chased does not necessarily want its
// responsible parties emailed. Both ladders end with the single 'lapsed' notice
// the day after the due day fully passed - one honest overdue message, never a
// daily nag.
//
// Idempotency: the day-matching is exact-day, so a scheduler redelivery the
// same day would duplicate every notice. A transaction claims a per-item
// per-day marker under /{env}/ops/deadlineReminders/... before anything is
// sent, the reviewReminders/dailyJobReminders precedent.
//
// Scale posture: one /{env}/assessments read and one /{env}/actions read per
// env, then in-memory walking, with per-org member/profile reads done once and
// only for orgs that actually matched today. Linear in estate size, which is
// comfortable at present scale; revisit with per-org fan-out if org counts
// reach the thousands.
// ============================================================================

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db } from '../admin';
import { REGION } from '../lib/region';
import { createLogger } from '../lib/logging';
import { forEnv } from '../shared/paths';
import type { EnvPaths } from '../lib/paths';
import { sendNotification } from '../lib/notifications';
import { EMAIL_PROVIDER_SECRETS } from '../lib/email';
import { orgEmailBrand, type EmailBrand } from '../lib/emailTemplates';
import { loadKindConfig } from '../lib/templatedEmail';
import { deliverKindEmail } from '../lib/emailDigest';
import { WEB_ORIGIN } from '../lib/webOrigin';
import {
  deadlineReminderStage,
  utcDayKey,
  type DeadlineStage,
} from '../lib/reviewWindows';
import {
  resolveReminderDays,
  ACTION_REMINDER_RULES,
  INFO_REQUEST_REMINDER_RULES,
} from '../lib/reminderSchedules';
import type { Logger } from '../lib/logging';
import type {
  Action,
  Assessment,
  AssessmentAnswer,
  Building,
  CustomerContact,
  Environment,
  Job,
  Keyed,
  OrgMember,
  OrgProfile,
  OrgSettings,
  Severity,
} from '../shared/types';

const ENVIRONMENTS: Environment[] = ['live', 'test'];

/** The per-org template resolution the seam returns, read once per (org, kind)
 *  so the fan-outs below never re-resolve it. */
type KindConfig = Awaited<ReturnType<typeof loadKindConfig>>;

/** Human severity wording for recipient-facing copy, matching manageAction's
 *  assignment email so an action reads the same however it reaches someone. */
const SEVERITY_LABELS: Record<Severity, string> = {
  L: 'Low',
  M: 'Medium',
  H: 'High',
};

/** The due date rendered for copy, UK-local so it names the day the recipient's
 *  own working calendar shows. */
function formatDueDate(millis: number): string {
  return new Date(millis).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/London',
  });
}

/** "in 3 days" / "today" / "overdue" - the shared phrase both channels use. */
function stagePhrase(stage: DeadlineStage): string {
  if (stage === 'lapsed') {
    return 'now overdue';
  }
  if (stage === 1) {
    return 'due tomorrow';
  }
  return `due in ${stage} days`;
}

/** Claim the once-per-day marker for one item. False means another delivery of
 *  the same run already sent this notice. */
async function claimMarker(env: Environment, suffix: string): Promise<boolean> {
  const marker = db.ref(`${env}/ops/deadlineReminders/${suffix}`);
  const claim = await marker.transaction((current) => (current ? undefined : true));
  return claim.committed;
}

/** An org's active admins, with their email preference resolved. Read once per
 *  org that actually matched, never for orgs with nothing due. */
interface OrgAudience {
  admins: Array<{ uid: string; email?: string; emailDeadlines: boolean }>;
  name: string;
  brand: EmailBrand;
  members: Keyed<OrgMember>;
}

async function loadOrgAudience(
  paths: EnvPaths,
  orgId: string,
): Promise<OrgAudience> {
  const membersSnap = await db.ref(paths.db.orgMembers(orgId)).get();
  const members = (membersSnap.val() as Keyed<OrgMember> | null) ?? {};
  const profileSnap = await db.ref(paths.db.orgProfile(orgId)).get();
  const profile = profileSnap.val() as OrgProfile | null;
  return {
    members,
    admins: Object.entries(members)
      .filter(
        ([, member]) =>
          member?.status === 'active' && member.roles?.admin === true,
      )
      .map(([uid, member]) => ({
        uid,
        email: member.email,
        // ABSENT means on; only an explicit false quietens the category.
        emailDeadlines: member.emailPreferences?.deadlineReminder !== false,
      })),
    name: profile?.name ?? 'Your organisation',
    brand: orgEmailBrand(profile),
  };
}

/** Locate a building by id within an org's estate map, which is keyed by site. */
function findBuilding(
  estate: Record<string, Record<string, Building>>,
  buildingId: string,
): { building: Building; siteId: string } | undefined {
  for (const [siteId, site] of Object.entries(estate)) {
    const building = site?.[buildingId];
    if (building) {
      return { building, siteId };
    }
  }
  return undefined;
}

// ----------------------------------------------------------------------------
// 1. Information requests waiting on an assessor.
// ----------------------------------------------------------------------------

async function sweepInfoRequests(
  env: Environment,
  paths: EnvPaths,
  now: number,
  today: string,
  logger: Logger,
): Promise<number> {
  const snap = await db.ref(`${env}/assessments`).get();
  if (!snap.exists()) {
    return 0;
  }
  const byOrg = snap.val() as Record<string, Keyed<Assessment>>;
  let sent = 0;

  for (const [orgId, assessments] of Object.entries(byOrg)) {
    let audience: OrgAudience | null = null;
    // The kind's resolved template, read once per org alongside the audience
    // rather than once per assessment.
    let kindConfig: KindConfig | null = null;

    // The configured ladder decides WHICH deadlines match today, so unlike the
    // audience it cannot be read lazily on first match - it is needed before the
    // walk begins. One settings read per org (never per assessment) keeps the
    // sweep linear in estate size.
    const settingsSnap = await db.ref(paths.db.orgSettings(orgId)).get();
    const settings = settingsSnap.val() as OrgSettings | null;
    // Absent means on, so an org that has never opened the setting keeps the
    // chases it already had; only an explicit false stops them.
    if (settings?.infoRequestRemindersEnabled === false) {
      continue;
    }
    const offsets = resolveReminderDays(
      settings?.infoRequestReminderDays,
      INFO_REQUEST_REMINDER_RULES,
    );

    for (const [assessmentId, assessment] of Object.entries(assessments ?? {})) {
      // A request only matters while the assessment is actually waiting on the
      // assessor; anything resubmitted or validated has moved on.
      if (assessment?.status !== 'infoRequired') {
        continue;
      }
      const answersSnap = await db
        .ref(paths.db.assessmentAnswers(orgId, assessmentId))
        .get();
      const answers = (answersSnap.val() as Keyed<AssessmentAnswer> | null) ?? {};

      // The governing deadline is the earliest across the OPEN requests: an
      // answered one is settled, whatever its date said.
      const openDueDates = Object.values(answers)
        .map((answer) => answer?.infoRequest)
        .filter(
          (request) =>
            request !== undefined &&
            !request.response &&
            request.resolvedAt === undefined &&
            typeof request.dueBy === 'number',
        )
        .map((request) => request!.dueBy as number);
      if (openDueDates.length === 0) {
        continue;
      }
      const dueBy = Math.min(...openDueDates);
      const stage = deadlineReminderStage(dueBy, now, offsets);
      if (stage === null) {
        continue;
      }

      // The assessor to chase is the one assigned to the originating job.
      const jobSnap = await db.ref(paths.db.job(orgId, assessment.jobId)).get();
      const job = jobSnap.val() as Job | null;
      if (!job?.assessorUid) {
        continue;
      }

      if (audience === null) {
        audience = await loadOrgAudience(paths, orgId);
        kindConfig = await loadKindConfig(
          env,
          orgId,
          'deadline-info-assessor',
          logger,
        );
      }
      // Only an ACTIVE member is reminded: a suspended or removed assessor is
      // no longer the person to chase (the dailyJobReminders guard).
      const member = audience.members[job.assessorUid];
      if (member?.status !== 'active') {
        continue;
      }

      if (!(await claimMarker(env, `info/${orgId}/${assessmentId}/${today}`))) {
        continue;
      }

      const count = openDueDates.length;
      const questions = `${count} ${count === 1 ? 'question' : 'questions'}`;
      const body = `Your response to ${questions} on a fire risk assessment is ${stagePhrase(stage)}.`;
      await sendNotification(
        paths,
        orgId,
        job.assessorUid,
        {
          type: 'reminder',
          title:
            stage === 'lapsed'
              ? 'Information request overdue'
              : 'Information request due',
          body,
          link: `safentia://assessment/${assessmentId}`,
        },
        logger,
      );

      if (member.email && member.emailPreferences?.deadlineReminder !== false) {
        await deliverKindEmail(
          {
            kind: 'deadline-info-assessor',
            env,
            orgId,
            to: member.email,
            variables: {
              // The subject drops the 'now' the body carries when lapsed, as
              // it always has.
              'info.subjectStagePhrase':
                stage === 'lapsed' ? 'overdue' : stagePhrase(stage),
              'info.stagePhrase': stagePhrase(stage),
              'info.questionsPhrase': questions,
              'info.dueDate': formatDueDate(dueBy),
              'info.statusLabel':
                stage === 'lapsed' ? 'Overdue' : stagePhrase(stage),
            },
            brand: audience.brand,
            kindLink: `${WEB_ORIGIN}/app/jobs/${assessment.jobId}`,
            // This assessment's line when the seam bundles an assessor's day
            // into one digest. The label is the assessment's own id because it
            // is the only identifier this sweep holds: it walks /assessments
            // and never reads the estate, so there is no building NAME here
            // without a per-assessment read the sweep deliberately avoids. The
            // row is there to tell one queued reminder from another; the CTA is
            // what carries the reader to the work.
            digestRow: {
              label: assessmentId,
              value: `${questions} outstanding, ${stagePhrase(stage)}`,
            },
            config: kindConfig ?? undefined,
          },
          logger,
        );
      }
      sent += 1;
    }
  }
  return sent;
}

// ----------------------------------------------------------------------------
// 2. Open actions on a building's action plan.
// ----------------------------------------------------------------------------

/** One matched action, held until the org's whole estate has been walked so the
 *  org's admins can be told ONCE rather than once per action (see the digest
 *  note in sweepActions). */
interface MatchedAction {
  buildingName: string;
  stage: DeadlineStage;
  dueBy: number;
  severity: Severity;
  excerpt: string;
  url: string;
}

async function sweepActions(
  env: Environment,
  paths: EnvPaths,
  now: number,
  today: string,
  logger: Logger,
): Promise<number> {
  const snap = await db.ref(`${env}/actions`).get();
  if (!snap.exists()) {
    return 0;
  }
  const byOrg = snap.val() as Record<string, Record<string, Keyed<Action>>>;
  let sent = 0;

  for (const [orgId, buildings] of Object.entries(byOrg)) {
    let audience: OrgAudience | null = null;
    let estate: Record<string, Record<string, Building>> | null = null;
    // The responsible-party kind's resolved template, read once per org
    // alongside the audience rather than once per action.
    let contactConfig: KindConfig | null = null;
    // Read before the estate walk for the same reason as the information-request
    // sweep: the ladder decides what matches, so it cannot wait for a match.
    const settingsSnap = await db.ref(paths.db.orgSettings(orgId)).get();
    const settings = settingsSnap.val() as OrgSettings | null;
    // Absent means on; an explicit false stops both the admin digest and the
    // responsible-party emails for this organisation.
    if (settings?.actionRemindersEnabled === false) {
      continue;
    }
    const offsets = resolveReminderDays(
      settings?.actionReminderDays,
      ACTION_REMINDER_RULES,
    );
    // The org's admins hear ONCE per morning, however many actions matched.
    // Emailing them per action would put a whole estate's worth of messages in
    // one inbox on a ladder day, and - worse - each in-app notice consumes a
    // slot of the org's monthly notification quota, which sendNotification
    // enforces by SILENTLY ABORTING once the cap is reached. A daily per-action
    // fan-out could therefore exhaust the cap and suppress unrelated
    // notifications (a submitted assessment, a cancelled job) for the rest of
    // the month. The responsible-party emails below stay per action: each goes
    // to a different person about their own building.
    const matched: MatchedAction[] = [];

    for (const [buildingId, actions] of Object.entries(buildings ?? {})) {
      for (const [actionId, action] of Object.entries(actions ?? {})) {
        // Only work still to do earns a chase; signed-off and archived are done.
        if (action?.status !== 'open' || typeof action.dueBy !== 'number') {
          continue;
        }
        const stage = deadlineReminderStage(action.dueBy, now, offsets);
        if (stage === null) {
          continue;
        }
        if (
          !(await claimMarker(
            env,
            `action/${orgId}/${buildingId}/${actionId}/${today}`,
          ))
        ) {
          continue;
        }

        if (audience === null) {
          audience = await loadOrgAudience(paths, orgId);
          contactConfig = await loadKindConfig(
            env,
            orgId,
            'deadline-action-contact',
            logger,
          );
        }
        if (estate === null) {
          const estateSnap = await db.ref(paths.db.buildingsRoot(orgId)).get();
          estate =
            (estateSnap.val() as Record<
              string,
              Record<string, Building>
            > | null) ?? {};
        }
        const located = findBuilding(estate, buildingId);
        const buildingName = located?.building.name ?? 'a building';

        const excerpt =
          action.observation.length > 200
            ? `${action.observation.slice(0, 200)}...`
            : action.observation;
        const detailRows = [
          { label: 'Building', value: buildingName },
          { label: 'Observation', value: excerpt },
          { label: 'Severity', value: SEVERITY_LABELS[action.severity] },
          { label: 'Due by', value: formatDueDate(action.dueBy) },
          ...(action.responsible
            ? [{ label: 'Responsible', value: action.responsible }]
            : []),
          ...(action.lifeProtection
            ? [
                {
                  label: 'Life protection',
                  value: 'This action affects life-safety measures.',
                },
              ]
            : []),
        ];
        // The console route to the building is the whole hierarchy, so the CTA
        // is only built when the building was actually located in the estate;
        // a guessed path would 404, which is worse than the plainer fallback.
        const buildingUrl =
          located && located.building.customerId
            ? `${WEB_ORIGIN}/app/customers/${located.building.customerId}/sites/${located.siteId}/buildings/${buildingId}`
            : `${WEB_ORIGIN}/app/customers`;

        // Held for the org's single admin digest, sent once the estate walk is
        // done (see the note on `matched`).
        matched.push({
          buildingName,
          stage,
          dueBy: action.dueBy,
          severity: action.severity,
          excerpt,
          url: buildingUrl,
        });

        // The responsible party themselves, by email, resolved the way
        // manageAction resolves an assignment: through the action's OWN
        // `responsibleContactId`. Every dead end is logged with its reason,
        // because a duty-holder who is never chased about statutory work is a
        // failure that has to be diagnosable from the logs alone. Contacts have
        // no preferences node, so there is no choice to respect here yet - the
        // same posture reviewReminders takes with the customer's overdue notice.
        if (!action.responsibleContactId) {
          logger.info(
            'Responsible-party chase skipped: this action carries no responsible contact (an unlinked legacy or imported party), so there is no address to send to',
            { orgId, buildingId, actionId },
          );
        } else if (!located) {
          logger.warn(
            'Responsible-party chase skipped: the action’s building is no longer in the org’s estate, so its customer’s contacts cannot be read',
            { orgId, buildingId, actionId },
          );
        } else {
          const contactSnap = await db
            .ref(
              paths.db.customerContact(
                orgId,
                located.building.customerId,
                action.responsibleContactId,
              ),
            )
            .get();
          const contact = contactSnap.val() as CustomerContact | null;
          if (!contact) {
            logger.warn(
              'Responsible-party chase skipped: the responsible contact is no longer in the customer’s contact list',
              {
                orgId,
                buildingId,
                actionId,
                contactId: action.responsibleContactId,
              },
            );
          } else if (!contact.email) {
            logger.info(
              'Responsible-party chase skipped: the responsible contact has no email address on record',
              {
                orgId,
                buildingId,
                actionId,
                contactId: action.responsibleContactId,
              },
            );
          } else {
            await deliverKindEmail(
              {
                kind: 'deadline-action-contact',
                env,
                orgId,
                to: contact.email,
                variables: {
                  'building.name': buildingName,
                  // The subject drops the 'now' the body carries when lapsed,
                  // as it always has.
                  'action.subjectStagePhrase':
                    stage === 'lapsed' ? 'overdue' : stagePhrase(stage),
                  'action.stagePhrase': stagePhrase(stage),
                  'action.severityLower':
                    SEVERITY_LABELS[action.severity].toLowerCase(),
                },
                brand: audience.brand,
                // The portal, not the staff console: a customer contact has
                // no access to /app/customers, so that link would only ever
                // show them a permission wall.
                kindLink: `${WEB_ORIGIN}/app/sites/${located.siteId}/buildings/${buildingId}`,
                // The detail card as built above, conditional rows included.
                kindRows: detailRows,
                // This action's line when the seam bundles a responsible
                // party's day into one digest. Deliberately the SAME row shape
                // the admin digest below builds for the same action, so a
                // duty-holder and the admin chasing them read the identical
                // wording about the identical piece of work.
                digestRow: {
                  label: buildingName,
                  value: `${SEVERITY_LABELS[action.severity]} severity, ${stagePhrase(stage)} (${formatDueDate(action.dueBy)})`,
                },
                config: contactConfig ?? undefined,
              },
              logger,
            );
          }
        }
        sent += 1;
      }
    }

    // ONE notice per admin for the whole org, whatever matched today. `audience`
    // is non-null exactly when something did.
    if (matched.length === 0 || audience === null) {
      continue;
    }
    const overdue = matched.filter((item) => item.stage === 'lapsed').length;
    const summary =
      matched.length === 1
        ? `A ${SEVERITY_LABELS[matched[0].severity].toLowerCase()} fire-safety action at ${matched[0].buildingName} is ${stagePhrase(matched[0].stage)}.`
        : `${matched.length} fire-safety actions on your action plans need attention${overdue > 0 ? `, ${overdue} of them overdue` : ''}.`;
    const subject =
      matched.length === 1
        ? matched[0].stage === 'lapsed'
          ? `Action overdue: ${matched[0].buildingName}`
          : `Action ${stagePhrase(matched[0].stage)}: ${matched[0].buildingName}`
        : `${matched.length} fire-safety actions need attention`;
    // One row per action for a digest; the fuller single-action detail when
    // there is only one, so nothing is lost in the common case.
    const digestRows =
      matched.length === 1
        ? [
            { label: 'Building', value: matched[0].buildingName },
            { label: 'Observation', value: matched[0].excerpt },
            {
              label: 'Severity',
              value: SEVERITY_LABELS[matched[0].severity],
            },
            { label: 'Due by', value: formatDueDate(matched[0].dueBy) },
          ]
        : matched.map((item) => ({
            label: item.buildingName,
            value: `${SEVERITY_LABELS[item.severity]} severity, ${stagePhrase(item.stage)} (${formatDueDate(item.dueBy)})`,
          }));
    // A single match deep-links to its own building; a digest can only point
    // at the customer list, which is where the reader picks one.
    const digestLink =
      matched.length === 1 ? matched[0].url : `${WEB_ORIGIN}/app/customers`;
    const digestCtaLabel =
      matched.length === 1 ? 'View the action plan' : 'View your customers';
    // Once per org, however many admins hear the digest.
    const digestConfig = await loadKindConfig(
      env,
      orgId,
      'deadline-admin-digest',
      logger,
    );
    for (const admin of audience.admins) {
      await sendNotification(
        paths,
        orgId,
        admin.uid,
        {
          type: 'reminder',
          title:
            matched.length === 1 && matched[0].stage === 'lapsed'
              ? 'Action overdue'
              : 'Actions due',
          body: summary,
          link: 'safentia://jobs',
        },
        logger,
      );
      if (admin.email && admin.emailDeadlines) {
        // Routed through the seam like every other send site, for uniformity -
        // but this kind is classified `immediate` in the catalogue and so is
        // never queued: it is ALREADY one email per admin per morning covering
        // the whole org, and bundling a digest into a digest would only put a
        // day's delay in front of copy that is already collapsed. It carries no
        // digestRow for the same reason - there is nothing for it to be a row
        // inside of.
        await deliverKindEmail(
          {
            kind: 'deadline-admin-digest',
            env,
            orgId,
            to: admin.email,
            variables: {
              'org.name': audience.name,
              'digest.subjectText': subject,
              'digest.summaryText': summary,
              'digest.ctaLabel': digestCtaLabel,
            },
            brand: audience.brand,
            kindLink: digestLink,
            kindRows: digestRows,
            config: digestConfig,
          },
          logger,
        );
      }
    }
  }
  return sent;
}

export const deadlineReminders = onSchedule(
  {
    schedule: '45 7 * * *',
    timeZone: 'Europe/London',
    region: REGION,
    secrets: EMAIL_PROVIDER_SECRETS,
  },
  async () => {
    const logger = createLogger({ fn: 'deadlineReminders' });
    const now = Date.now();
    const today = utcDayKey(now);
    let infoNotices = 0;
    let actionNotices = 0;

    for (const env of ENVIRONMENTS) {
      const paths = forEnv(env);
      infoNotices += await sweepInfoRequests(env, paths, now, today, logger);
      actionNotices += await sweepActions(env, paths, now, today, logger);
    }

    logger.info('Deadline reminders sent', {
      infoRequests: infoNotices,
      actions: actionNotices,
    });
  },
);
