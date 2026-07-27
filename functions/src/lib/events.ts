// ============================================================================
// Activity + log-book append helpers (brief 4.5 / section 6, story 1066).
//
// Both /activity and /logBook are APPEND-ONLY (rules deny update and delete). We
// append with push() so every entry gets a chronologically-sortable server key
// and two concurrent writers never collide. Centralising the two writes here means
// the exact entry shape (actor, target, timestamp) is produced one way everywhere,
// which is what keeps the Phase 2 log-book viewer gap-free (story 1066 AC).
// ============================================================================

import { db } from '../admin';
import type { EnvPaths } from './paths';
import type {
  ActivityEntry,
  LogBookEntry,
  LogBookType,
} from '../shared/types';

/**
 * Append an activity-stream entry for an org. Returns the generated key so a
 * caller can correlate it. `at` is stamped server-side here, never trusted from a
 * client, so the audit timeline cannot be back-dated.
 */
export async function appendActivity(
  env: EnvPaths,
  orgId: string,
  entry: Omit<ActivityEntry, 'at'>,
): Promise<string> {
  const ref = db.ref(env.db.activity(orgId)).push();
  const full: ActivityEntry = { ...entry, at: Date.now() };
  await ref.set(full);
  return ref.key as string;
}

/**
 * Build an activity entry as a multi-location-update fragment instead of writing
 * it. The admin callables spread this into the SAME db.ref().update() as their
 * data write, so the audit entry and the change it records land atomically - the
 * trail can never show a change without its entry or vice versa (the reason those
 * actions are callables at all). The push key is minted locally (no I/O); `at` is
 * stamped server-side here, same discipline as appendActivity.
 */
export function activityUpdate(
  env: EnvPaths,
  orgId: string,
  entry: Omit<ActivityEntry, 'at'>,
): Record<string, ActivityEntry> {
  const key = db.ref(env.db.activity(orgId)).push().key as string;
  const full: ActivityEntry = { ...entry, at: Date.now() };
  return { [env.db.activityEntry(orgId, key)]: full };
}

/**
 * Build a log-book entry as a multi-location-update fragment under a
 * DETERMINISTIC entry id, instead of appending under a push key. This exists for
 * the statutory once-only records (the released fraCompleted entry): a trigger
 * retry that re-runs the same logical event re-derives the same id and set()s
 * the same node, so the log book can never hold two copies of one statutory
 * fact. The caller spreads this into the SAME update() as its idempotency
 * marker, so the entry and the "already done" record land atomically. `at` is
 * stamped server-side, same discipline as the other builders here.
 */
export function logBookUpdate(
  env: EnvPaths,
  orgId: string,
  buildingId: string,
  entryId: string,
  type: LogBookType,
  byUid: string,
  payload: Record<string, unknown>,
): Record<string, LogBookEntry> {
  const full: LogBookEntry = { type, payload, byUid, at: Date.now() };
  return { [env.db.logBookEntry(orgId, buildingId, entryId)]: full };
}

/**
 * Append a log-book entry for a building. Same append-only, server-stamped
 * discipline. The payload is type-specific (validated by the caller against the
 * entry type) so the log book can carry heterogeneous events under one shape.
 */
export async function appendLogBook(
  env: EnvPaths,
  orgId: string,
  buildingId: string,
  type: LogBookType,
  byUid: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const ref = db.ref(env.db.logBook(orgId, buildingId)).push();
  const full: LogBookEntry = { type, payload, byUid, at: Date.now() };
  await ref.set(full);
  return ref.key as string;
}
