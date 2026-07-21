// ============================================================================
// exportBackups (scheduled) - nightly RTDB export to Storage.
//
// Every night at 02:30 UK time the whole database is exported, root by root
// (live, test, platform), as timestamped JSON objects under backups/{date}/ in
// the DEFAULT bucket. The backups/** prefix is denied to ALL clients in
// storage.rules; only the Admin SDK (and console operators) can touch it.
// Restore procedure: SETUP.md, "Backups and restore".
//
// SIZE CAVEAT: each root is read into memory in one get() and serialised as a
// single JSON string. That is entirely acceptable at the platform's current
// scale (tens of orgs, thousands of records - a few MB), but it is O(database)
// in memory. If the estate grows towards the Function's memory ceiling,
// shard the export per top-level child (per-org files) - noted in
// FUTURE_WORK.md so the revisit is on the record.
// ============================================================================

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db, storage } from '../admin';
import { REGION } from '../lib/region';
import { createLogger } from '../lib/logging';

/** Every top-level root the schema defines: the two environment roots plus the
 *  global /platform tree (plans, superAdmins, leads). /metadata (token-refresh
 *  markers) and /ops (rate-limit counters) are ephemeral operational state and
 *  are deliberately not backed up. */
const ROOTS = ['live', 'test', 'platform'] as const;

/** The export day, UTC, as YYYY-MM-DD - one folder per calendar day, so a
 *  scheduler retry the same night overwrites rather than duplicates. */
function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export const exportBackups = onSchedule(
  {
    schedule: '30 2 * * *',
    timeZone: 'Europe/London',
    region: REGION,
    // JSON-serialising the whole database needs headroom beyond the default.
    memory: '1GiB',
    timeoutSeconds: 540,
  },
  async () => {
    const logger = createLogger({ fn: 'exportBackups' });
    const date = dayKey(Date.now());
    const bucket = storage.bucket();

    for (const root of ROOTS) {
      const snap = await db.ref(root).get();
      // An absent root still writes an explicit empty object: the backup set
      // for a day is always complete, never "missing file or empty tree?".
      const payload = JSON.stringify(snap.val() ?? {});
      const objectPath = `backups/${date}/rtdb-${root}.json`;
      await bucket.file(objectPath).save(payload, {
        contentType: 'application/json',
        resumable: false,
        metadata: { cacheControl: 'private, no-cache, max-age=0' },
      });
      logger.info('Backup root exported', {
        root,
        objectPath,
        bytes: payload.length,
      });
    }

    logger.info('Backup export complete', { date, roots: ROOTS.length });
  },
);
