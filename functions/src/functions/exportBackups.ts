// ============================================================================
// exportBackups (scheduled) - nightly RTDB export to Storage.
//
// Every night at 02:30 UK time the whole database is exported, root by root
// (live, test, platform), as timestamped JSON objects under backups/{date}/ in
// the DEFAULT bucket. The backups/** prefix is denied to ALL clients in
// storage.rules; only the Admin SDK (and console operators) can touch it.
// Restore procedure: SETUP.md, "Backups and restore".
//
// RETENTION: after a successful export, day folders older than
// BACKUP_RETENTION_DAYS are deleted. Without this the bucket kept every night
// forever, so an offboarded organisation's data (DECISIONS.md section 8 -
// deleted on request or after the 12-month window) would have survived
// indefinitely inside old whole-database snapshots. Pruning is best-effort: a
// failure is logged and never fails the night's export.
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

/**
 * How many days of nightly backups are kept. No backup-specific retention is
 * stated anywhere in the project docs (DECISIONS.md section 8 only sets the
 * 12-month post-cancellation window for LIVE org data), so this is a chosen
 * default: 35 days gives a full month of point-in-time restore plus a few days'
 * slack to notice a problem, while bounding how long an erased org's data can
 * linger in snapshots to about five weeks after its deletion. Revisit if the
 * client sets a formal backup-retention policy.
 */
const BACKUP_RETENTION_DAYS = 35;

/** A backup day folder name: exactly YYYY-MM-DD, as written by dayKey. */
const DAY_FOLDER = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True only when `folder` is a real calendar date (not merely date-shaped -
 * "2026-02-31" is rejected by the round-trip) STRICTLY older than `cutoff`.
 * Anything that does not parse is never a deletion candidate: the prune only
 * ever removes folders this function itself would have written.
 */
function isExpiredDayFolder(folder: string, cutoff: string): boolean {
  if (!DAY_FOLDER.test(folder)) return false;
  const parsed = Date.parse(`${folder}T00:00:00Z`);
  if (Number.isNaN(parsed) || dayKey(parsed) !== folder) return false;
  // YYYY-MM-DD compares chronologically as a string.
  return folder < cutoff;
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

    // Retention prune - only reached once every root above saved, so a failed
    // export never deletes the older sets it would otherwise be falling back
    // on. The cutoff is computed from today's folder, and today's folder can
    // never be older than its own cutoff, so tonight's set is never touched.
    try {
      const cutoff = dayKey(
        Date.parse(`${date}T00:00:00Z`) - BACKUP_RETENTION_DAYS * 86_400_000,
      );
      const [files] = await bucket.getFiles({ prefix: 'backups/' });
      const expired = new Set<string>();
      for (const file of files) {
        // backups/{folder}/{object} - anything not in that shape is left alone.
        const folder = file.name.split('/')[1];
        if (folder && folder !== date && isExpiredDayFolder(folder, cutoff)) {
          expired.add(folder);
        }
      }
      for (const folder of expired) {
        // The trailing slash scopes the delete to exactly this day's folder.
        await bucket.deleteFiles({ prefix: `backups/${folder}/` });
      }
      logger.info('Backup retention prune complete', {
        cutoff,
        retentionDays: BACKUP_RETENTION_DAYS,
        deletedFolders: [...expired].sort(),
      });
    } catch (error) {
      logger.error('Backup retention prune failed (export itself succeeded)', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  },
);
