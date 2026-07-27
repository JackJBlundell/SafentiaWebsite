// ============================================================================
// dailyJobReminders (scheduled) - a once-a-day "jobs due today" nudge.
//
// Every morning at 07:00 UK time we look across both environment roots and, for
// each organisation, count how many of an assessor's jobs are scheduled for TODAY
// and still need attending. Each assessor with one or more gets a single
// notification ("You have 4 jobs scheduled today.") - in-app plus a best-effort
// push - via the shared sendNotification helper (which also accounts the org's
// monthly notification quota and targets the user's registered devices).
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
import { ukDay } from '../lib/ukCalendar';
import type { Environment, Job } from '../shared/types';

const ENVIRONMENTS: Environment[] = ['live', 'test'];

/** A job needs the assessor ON SITE today only while it is scheduled or in
 *  progress. Once it is awaiting validation/release (assessor's work done),
 *  validated, released or cancelled, it is not a "coming up today" item. */
function needsAttendance(status: Job['status']): boolean {
  return status === 'scheduled' || status === 'inProgress';
}

export const dailyJobReminders = onSchedule(
  {
    schedule: '0 7 * * *',
    timeZone: 'Europe/London',
    region: REGION,
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
        // Count today's still-to-attend jobs per assessor.
        const counts: Record<string, number> = {};
        for (const job of Object.values(jobs ?? {})) {
          if (
            job &&
            needsAttendance(job.status) &&
            typeof job.scheduledFor === 'number' &&
            ukDay(job.scheduledFor) === today
          ) {
            counts[job.assessorUid] = (counts[job.assessorUid] ?? 0) + 1;
          }
        }

        for (const [assessorUid, count] of Object.entries(counts)) {
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
          notified += 1;
        }
      }
    }

    logger.info('Daily job reminders sent', { recipients: notified });
  },
);
