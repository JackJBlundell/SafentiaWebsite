// ============================================================================
// cleanupExpiredOrgs (scheduled) - the nightly data-retention reaper
// (DECISIONS §8).
//
// A cancelled organisation's data is kept for 12 months, then deleted. The
// Stripe webhook stamps `subscription.retentionUntil` at final cancellation;
// this sweep finds orgs whose clock has ELAPSED and erases them via the shared
// deleteOrgData core.
//
// Because whole-org deletion is irreversible, this function is built to fail
// SAFE, not fast:
//
//   * REPORT-ONLY BY DEFAULT. It ALWAYS logs every org it would reap, but only
//     performs the deletion when `FIRERITE_ENABLE_RETENTION_DELETION=true` is
//     set in the runtime env (retentionDeletionEnabled). Unset - the production
//     default until the policy copy is client-signed-off - means it runs as a
//     pure dry run, night after night, so operators can watch the candidate
//     list before ever arming it.
//   * RETENTION-GATED. An org is a candidate ONLY when its own stamped clock has
//     provably passed (retentionElapsed). A missing or unparseable clock is
//     never a candidate - "cannot prove it is elapsed" means "do not reap".
//   * BLAST-RADIUS BOUNDED. At most RETENTION_DELETE_BATCH orgs are reaped per
//     run; a larger backlog drains over successive nights. The org list itself
//     bounds the walk (linear in org count - the cleanupBilling / deadline
//     posture); deletion never scans the bulk data trees (see deleteOrgData).
//
// This is deliberately a SEPARATE scheduled function from cleanupBilling: that
// job trims bookkeeping rows on a fixed clock and is safe to run unconditionally,
// whereas this one erases tenants and must stay behind its own explicit flag.
// ============================================================================

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { REGION } from '../lib/region';
import { createLogger } from '../lib/logging';
import { forEnv } from '../lib/paths';
import { deleteOrgData } from '../lib/deleteOrgData';
import {
  RETENTION_DELETE_BATCH,
  RETENTION_DELETION_FLAG,
  RETENTION_ENVIRONMENTS,
  retentionDeletionEnabled,
  selectExpiredOrgs,
} from '../lib/orgRetention';
import type { Organisation } from '../shared/types';

export const cleanupExpiredOrgs = onSchedule(
  {
    // 04:15 UK - after cleanupBilling (03:45) so a night's billing tidy-up runs
    // first, and comfortably clear of the 02:30 backup and the reminder sweeps.
    schedule: '15 4 * * *',
    timeZone: 'Europe/London',
    region: REGION,
  },
  async () => {
    const logger = createLogger({ fn: 'cleanupExpiredOrgs' });
    const { db } = await import('../admin');
    const now = Date.now();
    const deletionArmed = retentionDeletionEnabled(
      process.env[RETENTION_DELETION_FLAG],
    );

    for (const env of RETENTION_ENVIRONMENTS) {
      const orgsSnap = await db.ref(forEnv(env).db.organisationsRoot()).get();
      const orgs =
        (orgsSnap.val() as Record<string, Organisation> | null) ?? {};
      const candidates = selectExpiredOrgs(orgs, now, RETENTION_DELETE_BATCH);

      logger.info('Retention sweep candidates', {
        env,
        deletionArmed,
        totalOrgs: Object.keys(orgs).length,
        expiredCandidates: candidates.length,
        candidateOrgIds: candidates,
      });

      for (const orgId of candidates) {
        // apply only when the env flag is armed; otherwise deleteOrgData reports
        // what it WOULD remove and writes nothing.
        const report = await deleteOrgData(env, orgId, logger, {
          apply: deletionArmed,
        });
        if (!deletionArmed) {
          logger.warn(
            'Retention elapsed but deletion NOT armed - reporting only',
            {
              env,
              orgId,
              orgName: report.orgName,
              flag: RETENTION_DELETION_FLAG,
            },
          );
        }
      }
    }
  },
);
