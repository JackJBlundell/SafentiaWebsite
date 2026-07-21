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
//      exactly as manageAction's assignment email resolves it (the building's
//      linked responsibleParty contact, name-matched). Responsible parties are
//      customer contacts, not org members: they have no in-app inbox and no
//      preferences node, so the IN-APP notice goes to the org's active admins,
//      who are the people who can actually chase it inside Safentia.
//
// Reminder ladders differ because the deadlines do. An information request runs
// for INFO_REQUEST_DUE_DAYS (7) by default, so a 60/30/7 ladder would never
// fire: it gets 3 and 1 days out. An action's default window is 7, 30 or 90
// days by severity (DUE_WINDOW_DAYS), so it gets 30, 7 and 1. Both end with the
// single 'lapsed' notice the day after the due day fully passed - one honest
// overdue message, never a daily nag.
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
import { dispatchEmail, EMAIL_PROVIDER_SECRETS } from '../lib/email';
import {
  orgEmailBrand,
  renderBrandedEmail,
  type EmailBrand,
} from '../lib/emailTemplates';
import { WEB_ORIGIN } from '../lib/webOrigin';
import {
  deadlineReminderStage,
  utcDayKey,
  type DeadlineStage,
} from '../lib/reviewWindows';
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
  Severity,
} from '../shared/types';

const ENVIRONMENTS: Environment[] = ['live', 'test'];

/** Human severity wording for recipient-facing copy, matching manageAction's
 *  assignment email so an action reads the same however it reaches someone. */
const SEVERITY_LABELS: Record<Severity, string> = {
  L: 'Low',
  M: 'Medium',
  H: 'High',
};

/** An information request's week-long window: a nudge with three days left,
 *  a final one the day before, then the overdue notice. */
const INFO_REQUEST_OFFSETS = [3, 1] as const;

/** An action's window runs to three months at severity L, so it earns a longer
 *  ladder: a month out, a week out, the day before, then overdue. */
const ACTION_OFFSETS = [30, 7, 1] as const;

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
      const stage = deadlineReminderStage(dueBy, now, INFO_REQUEST_OFFSETS);
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
        const subject =
          stage === 'lapsed'
            ? 'An information request is overdue'
            : `An information request is ${stagePhrase(stage)}`;
        await dispatchEmail(
          {
            to: member.email,
            subject,
            body,
            html: renderBrandedEmail({
              brand: audience.brand,
              preheader: body,
              heading: 'Information still required',
              paragraphs: [
                body,
                'Open the job, answer each flagged question and resubmit the assessment. It returns to the validation queue once you do.',
              ],
              detailRows: [
                { label: 'Questions outstanding', value: questions },
                { label: 'Response due by', value: formatDueDate(dueBy) },
                {
                  label: 'Status',
                  value: stage === 'lapsed' ? 'Overdue' : stagePhrase(stage),
                },
              ],
              cta: {
                label: 'Open the job',
                url: `${WEB_ORIGIN}/app/jobs/${assessment.jobId}`,
              },
              footerNote:
                'You are receiving this because you are the assessor on this job. You can turn these emails off in your Safentia account settings.',
            }),
          },
          logger,
          { orgId, env, category: 'deadline-reminder' },
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

    for (const [buildingId, actions] of Object.entries(buildings ?? {})) {
      for (const [actionId, action] of Object.entries(actions ?? {})) {
        // Only work still to do earns a chase; signed-off and archived are done.
        if (action?.status !== 'open' || typeof action.dueBy !== 'number') {
          continue;
        }
        const stage = deadlineReminderStage(action.dueBy, now, ACTION_OFFSETS);
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
        const body = `A ${SEVERITY_LABELS[action.severity].toLowerCase()} fire-safety action at ${buildingName} is ${stagePhrase(stage)}.`;
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

        // In-app to the org's admins: the responsible party is a customer
        // contact with no Safentia inbox, so the people who can act on a
        // slipping action inside the product are the ones told here.
        for (const admin of audience.admins) {
          await sendNotification(
            paths,
            orgId,
            admin.uid,
            {
              type: 'reminder',
              title: stage === 'lapsed' ? 'Action overdue' : 'Action due',
              body,
              link: 'safentia://jobs',
            },
            logger,
          );
          if (admin.email && admin.emailDeadlines) {
            await dispatchEmail(
              {
                to: admin.email,
                subject:
                  stage === 'lapsed'
                    ? `Action overdue: ${buildingName}`
                    : `Action ${stagePhrase(stage)}: ${buildingName}`,
                body,
                html: renderBrandedEmail({
                  brand: audience.brand,
                  preheader: body,
                  heading: `${audience.name}: action plan`,
                  paragraphs: [
                    body,
                    'Please check the remedial work is arranged, and sign the action off once it is complete.',
                  ],
                  detailRows,
                  cta: { label: 'View the action plan', url: buildingUrl },
                  footerNote: `You are receiving this because you are an administrator of ${audience.name} on Safentia.`,
                }),
              },
              logger,
              { orgId, env, category: 'deadline-reminder' },
            );
          }
        }

        // The responsible party themselves, by email, resolved the way
        // manageAction resolves an assignment: the building's LINKED party
        // contact, whose recorded name must match the action's free-text
        // `responsible` (the field is not a foreign key yet, so the match is
        // what makes the address trustworthy). Contacts have no preferences
        // node, so there is no choice to respect here yet - the same posture
        // reviewReminders takes with the customer's overdue notice.
        const party = located ? located.building.responsibleParty : undefined;
        if (
          located &&
          party?.contactId &&
          action.responsible &&
          action.responsible.trim().toLowerCase() ===
            party.name.trim().toLowerCase()
        ) {
          const contactSnap = await db
            .ref(
              paths.db.customerContact(
                orgId,
                located.building.customerId,
                party.contactId,
              ),
            )
            .get();
          const contact = contactSnap.val() as CustomerContact | null;
          if (contact?.email) {
            await dispatchEmail(
              {
                to: contact.email,
                subject:
                  stage === 'lapsed'
                    ? `An action assigned to you is overdue: ${buildingName}`
                    : `An action assigned to you is ${stagePhrase(stage)}: ${buildingName}`,
                body,
                html: renderBrandedEmail({
                  brand: audience.brand,
                  preheader: body,
                  heading: 'A fire-safety action needs your attention',
                  paragraphs: [
                    body,
                    'Please arrange the remedial work. Your provider signs the action off once it is complete.',
                  ],
                  detailRows,
                  // The portal, not the staff console: a customer contact has
                  // no access to /app/customers, so that link would only ever
                  // show them a permission wall.
                  cta: {
                    label: 'View your building',
                    url: `${WEB_ORIGIN}/app/sites/${located.siteId}/buildings/${buildingId}`,
                  },
                  footerNote: `You are receiving this because you are named as the responsible party for ${buildingName} on Safentia.`,
                }),
              },
              logger,
              { orgId, env, category: 'deadline-reminder' },
            );
          }
        }
        sent += 1;
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
