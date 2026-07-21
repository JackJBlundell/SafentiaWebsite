// ============================================================================
// cleanupLeads (scheduled) - lead retention enforcement.
//
// The public privacy policy (src/pages/legal/Privacy.tsx) promises that
// register-interest enquiries are "retained for up to 24 months". This job is
// what makes that promise TRUE: every night it deletes any /platform/leads
// entry whose receivedAt is older than 24 months, so the stated retention
// period is enforced by machinery rather than by intention.
//
// Leads are platform-global (a lead pre-dates any tenant - see shared/paths),
// so there is no per-env walk here: one read of /platform/leads, one
// multi-location delete of the expired keys. A malformed record (missing or
// non-numeric receivedAt) is ALSO deleted: it cannot prove it is within the
// retention window, and keeping unprovable PII indefinitely is the exact
// failure the policy forbids.
// ============================================================================

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db } from '../admin';
import { REGION } from '../lib/region';
import { createLogger } from '../lib/logging';
import { paths } from '../lib/paths';
import type { PlatformLead } from '../shared/types';

/** 24 months, expressed in days to sidestep month-length ambiguity: 730 days
 *  is two years to within a day, always in the lead's favour on leap years. */
const RETENTION_MS = 730 * 24 * 60 * 60 * 1000;

export const cleanupLeads = onSchedule(
  {
    schedule: '15 3 * * *',
    timeZone: 'Europe/London',
    region: REGION,
  },
  async () => {
    const logger = createLogger({ fn: 'cleanupLeads' });
    const cutoff = Date.now() - RETENTION_MS;

    const snap = await db.ref(paths.platform.leads()).get();
    if (!snap.exists()) {
      logger.info('Lead retention sweep: no leads stored');
      return;
    }

    const leads = (snap.val() as Record<string, PlatformLead> | null) ?? {};
    const removals: Record<string, null> = {};
    for (const [leadId, lead] of Object.entries(leads)) {
      const receivedAt = lead?.receivedAt;
      // Expired, or unprovable (no valid timestamp): both must go - see header.
      if (typeof receivedAt !== 'number' || receivedAt < cutoff) {
        removals[paths.platform.lead(leadId)] = null;
      }
    }

    const removed = Object.keys(removals).length;
    if (removed > 0) {
      await db.ref().update(removals);
    }
    logger.info('Lead retention sweep complete', {
      total: Object.keys(leads).length,
      removed,
    });
  },
);
