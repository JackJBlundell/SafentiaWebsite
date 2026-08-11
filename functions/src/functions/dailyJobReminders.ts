// ============================================================================
// dailyJobReminders (scheduled) - a once-a-day "jobs due today" nudge.
//
// Every morning at 07:00 UK time we look across both environment roots and, for
// each organisation, collect the assessor's jobs scheduled for TODAY that still
// need attending. Each assessor with one or more gets a single notification
// ("You have 4 jobs scheduled today.") - in-app plus a best-effort push - via
// the shared sendNotification helper (which also accounts the org's monthly
// notification quota and targets the user's registered devices), and ONE branded
// email listing the day (recipient resolved by lib/jobEmails, rendered through
// lib/templatedEmail), never one email per job: a morning of
// five separate messages is how a digest becomes noise. The email is additional
// and honours the member's own `jobScheduled` preference; the notification is
// unconditional.
//
// "Today" is the UK calendar day (lib/ukCalendar), compared by formatting both
// the run time and each job's scheduledFor in Europe/London - correct across the
// BST/GMT switch without any offset arithmetic. The job pulls one /{env}/jobs read
// per env, then groups in memory, so it is a handful of reads regardless of org
// count.
//
// This digest can only ever describe the diary AS IT STOOD AT 07:00. A job booked
// (or moved) into today AFTER the run is announced by its own createJob /
// rescheduleJob notification, whose copy names the day - see lib/ukCalendar's
// ukWhenPhrase. That is the pair: one morning overview, plus a live nudge for
// anything that lands later in the day.
// ============================================================================

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db } from '../admin';
import { REGION } from '../lib/region';
import { createLogger } from '../lib/logging';
import { forEnv } from '../shared/paths';
import { sendNotification } from '../lib/notifications';
import { WEB_ORIGIN } from '../lib/webOrigin';
import { EMAIL_PROVIDER_SECRETS } from '../lib/email';
import { loadKindConfig, sendKindEmail } from '../lib/templatedEmail';
import { jobEmailRecipient, formatVisitTime } from '../lib/jobEmails';
import { ukDay } from '../lib/ukCalendar';
import type { EnvPaths } from '../shared/paths';
import type { Building, Customer, Environment, Job } from '../shared/types';

const ENVIRONMENTS: Environment[] = ['live', 'test'];

/** The per-org template resolution the seam returns, read once per org so the
 *  assessor fan-out below never re-resolves it. */
type KindConfig = Awaited<ReturnType<typeof loadKindConfig>>;

/** A job needs the assessor ON SITE today only while it is scheduled or in
 *  progress. Once it is awaiting validation/release (assessor's work done),
 *  validated, released or cancelled, it is not a "coming up today" item. */
function needsAttendance(status: Job['status']): boolean {
  return status === 'scheduled' || status === 'inProgress';
}

/**
 * The names the digest prints: buildingId -> name and customerId -> name for one
 * organisation. Two reads, taken once per org and only when there is an email to
 * write, so an org with nobody out today costs nothing extra. Buildings are
 * flattened out of their sites because a job names its building, not its site.
 */
async function loadOrgDirectory(
  paths: EnvPaths,
  orgId: string,
): Promise<{ buildings: Record<string, string>; customers: Record<string, string> }> {
  const estateSnap = await db.ref(paths.db.buildingsRoot(orgId)).get();
  const estate =
    (estateSnap.val() as Record<string, Record<string, Building>> | null) ?? {};
  const buildings: Record<string, string> = {};
  for (const site of Object.values(estate)) {
    for (const [buildingId, building] of Object.entries(site ?? {})) {
      buildings[buildingId] = building?.name ?? 'A building';
    }
  }

  const customersSnap = await db.ref(paths.db.customers(orgId)).get();
  const directory =
    (customersSnap.val() as Record<string, Customer> | null) ?? {};
  const customers: Record<string, string> = {};
  for (const [customerId, customer] of Object.entries(directory)) {
    if (customer?.name) {
      customers[customerId] = customer.name;
    }
  }

  return { buildings, customers };
}

export const dailyJobReminders = onSchedule(
  {
    schedule: '0 7 * * *',
    timeZone: 'Europe/London',
    region: REGION,
    // Without the secret mounted the digest email degrades to a logged intent
    // (lib/email); the in-app reminder is unaffected either way.
    secrets: EMAIL_PROVIDER_SECRETS,
  },
  async () => {
    const logger = createLogger({ fn: 'dailyJobReminders' });
    const today = ukDay(Date.now());
    let notified = 0;

    for (const env of ENVIRONMENTS) {
      const paths = forEnv(env);
      // One read of the env's jobs tree: { orgId: { jobId: Job } }.
      const snap = await db.ref(`${env}/jobs`).get();
      if (!snap.exists()) {
        continue;
      }
      const byOrg = snap.val() as Record<string, Record<string, Job>>;

      for (const [orgId, jobs] of Object.entries(byOrg)) {
        // Today's still-to-attend jobs, grouped by assessor. The entries
        // themselves, not a bare count: the digest email lists the day, and the
        // notification's count is simply the list's length.
        const diaries: Record<string, Job[]> = {};
        for (const job of Object.values(jobs ?? {})) {
          if (
            job &&
            needsAttendance(job.status) &&
            typeof job.scheduledFor === 'number' &&
            ukDay(job.scheduledFor) === today
          ) {
            (diaries[job.assessorUid] ??= []).push(job);
          }
        }
        // Resolved on the first digest this org actually sends (see
        // loadOrgDirectory), then reused for its other assessors.
        let directory: Awaited<ReturnType<typeof loadOrgDirectory>> | null = null;
        // Likewise the kind's resolved template: once per org, never per
        // assessor.
        let kindConfig: KindConfig | null = null;

        for (const [assessorUid, visits] of Object.entries(diaries)) {
          const count = visits.length;
          // Only notify assessors who are still active members of the org.
          const statusSnap = await db
            .ref(paths.db.orgMember(orgId, assessorUid))
            .child('status')
            .get();
          if (statusSnap.val() !== 'active') {
            continue;
          }

          // Idempotency: send at most one reminder per assessor per UK day, even
          // if the scheduler delivers more than once. A transaction claims the
          // day marker; if it was already set, another run got here first.
          const marker = db.ref(
            `${env}/ops/jobReminders/${orgId}/${assessorUid}/${today}`,
          );
          const claim = await marker.transaction((current) =>
            current ? undefined : true,
          );
          if (!claim.committed) {
            continue;
          }

          await sendNotification(
            paths,
            orgId,
            assessorUid,
            {
              type: 'reminder',
              title: 'Jobs due today',
              body: `You have ${count} job${count === 1 ? '' : 's'} scheduled today.`,
              link: 'safentia://jobs',
            },
            logger,
          );

          // ONE email for the whole day, listing the visits in the order they
          // fall. Wrapped whole: the reminder above has already been sent and
          // the marker already claimed, so nothing about naming the visits may
          // abort the sweep for the assessors still to come.
          try {
            const recipient = await jobEmailRecipient(paths, orgId, assessorUid);
            if (recipient) {
              if (directory === null) {
                directory = await loadOrgDirectory(paths, orgId);
              }
              if (kindConfig === null) {
                kindConfig = await loadKindConfig(
                  env,
                  orgId,
                  'job-reminder',
                  logger,
                );
              }
              const names = directory;
              // Earliest first: the digest is read as the day's running order.
              const ordered = [...visits].sort(
                (a, b) => a.scheduledFor - b.scheduledFor,
              );
              const lines = ordered.map((visit) => {
                const buildingName = names.buildings[visit.buildingId] ?? 'A building';
                const customerName = names.customers[visit.customerId];
                return {
                  time: formatVisitTime(visit.scheduledFor, visit.scheduledUntil),
                  buildingName,
                  customerName,
                };
              });
              const detailRows = lines.map((line) => ({
                label: line.time,
                // The customer sits under the building on its own line; the
                // template turns the newline into a <br>.
                value: line.customerName
                  ? `${line.buildingName}\n${line.customerName}`
                  : line.buildingName,
              }));

              await sendKindEmail(
                {
                  kind: 'job-reminder',
                  env,
                  orgId,
                  to: recipient.email,
                  variables: {
                    'jobs.visitCountPhrase': `${count} visit${count === 1 ? '' : 's'}`,
                    'jobs.countPhrase': `${count} job${count === 1 ? '' : 's'}`,
                  },
                  brand: recipient.brand,
                  // The list, not a single job: the digest is the day.
                  kindLink: `${WEB_ORIGIN}/app/jobs`,
                  // The day's visits in running order.
                  kindRows: detailRows,
                  config: kindConfig,
                },
                logger,
              );
            }
          } catch (error) {
            logger.warn('Daily job digest email failed', {
              orgId,
              message: error instanceof Error ? error.message : String(error),
            });
          }
          notified += 1;
        }
      }
    }

    logger.info('Daily job reminders sent', { recipients: notified });
  },
);
