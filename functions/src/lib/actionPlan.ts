// ============================================================================
// Action-plan record building (story 2043/2044) - the PURE half of manageAction.
//
// manageAction (the callable) does the auth, validation and I/O; the record
// shapes live here so the contract-critical facts are unit-testable without an
// emulator: the DUE_WINDOW_DAYS default, the sign-off stamp, and the update
// whitelist that can never move `status`.
//
// MANUAL ACTIONS AND assessmentId: the Action type requires `assessmentId`,
// `sectionCode` and `question` because Phase 1 actions were only ever born from
// an assessment finding. An admin-created action between assessments has no
// originating assessment, section or question, and pretending otherwise would
// corrupt provenance. The honest representation within the frozen type:
//   - assessmentId: the literal 'manual' sentinel (MANUAL_ASSESSMENT_ID) - it
//     can never collide with a push key, and readers can branch on it.
//   - sectionCode: the same 'manual' sentinel (SectionCode is an opaque string
//     since the template-driven rendering work, so this is a valid member).
//   - question: '' - there IS no originating question; renderers must fall back
//     to the observation, never assume a question exists (brief 18.3).
// ============================================================================

import {
  DUE_WINDOW_DAYS,
  type Action,
  type ActionCustomerResponse,
  type ActionStatusChange,
  type SafentiaDocument,
  type Severity,
} from '../shared/types';

/** Sentinel assessmentId/sectionCode for admin-created (manual) actions. */
export const MANUAL_ASSESSMENT_ID = 'manual';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The fields an admin may supply on create (validated by the callable).
 *
 *  `responsible` is NOT a caller-supplied string: manageAction derives it from
 *  the CustomerContact named by `responsibleContactId`, so the pair that lands
 *  on the record always describes one real, emailable person. */
export interface CreateActionFields {
  observation: string;
  severity: Severity;
  responsible?: string;
  responsibleContactId?: string;
  dueBy?: number;
  lifeProtection?: boolean;
}

/**
 * Build a manual action record. Defaults are the contract's, applied server-side
 * so a thin client cannot ship a wrong one: dueBy falls out of DUE_WINDOW_DAYS
 * for the severity (H 7d, M 30d, L 90d) when not given, lifeProtection defaults
 * false, status is always 'open' - a new action can never be born signed off.
 */
export function createActionRecord(
  fields: CreateActionFields,
  now: number,
): Action {
  return {
    assessmentId: MANUAL_ASSESSMENT_ID,
    sectionCode: MANUAL_ASSESSMENT_ID,
    question: '',
    observation: fields.observation,
    severity: fields.severity,
    dueBy: fields.dueBy ?? now + DUE_WINDOW_DAYS[fields.severity] * DAY_MS,
    lifeProtection: fields.lifeProtection ?? false,
    status: 'open',
    ...(fields.responsible !== undefined
      ? { responsible: fields.responsible }
      : {}),
    ...(fields.responsibleContactId !== undefined
      ? { responsibleContactId: fields.responsibleContactId }
      : {}),
  };
}

/** The update whitelist (the contract comment on ManageActionInput). `status`,
 *  `signedOffBy` and `signedOffAt` are deliberately absent: status moves ONLY
 *  through signOff/reopen so the provenance stamp can never be forged.
 *
 *  `responsible` is absent too, and that is the point: re-assignment happens by
 *  naming a CONTACT, and the callable writes the name from that contact's own
 *  record. A free-text responsible party could never be emailed, so it is no
 *  longer accepted from a caller at all. */
export const UPDATABLE_ACTION_FIELDS = [
  'observation',
  'severity',
  'responsibleContactId',
  'dueBy',
  'lifeProtection',
] as const;

/**
 * The multi-location-update fragment that moves an open action to in progress
 * (story 2044). No provenance stamp: in-progress is a working state, not a
 * closure, so only the appended status-history entry records who started it.
 */
export function startFragment(actionPath: string): Record<string, unknown> {
  return {
    [`${actionPath}/status`]: 'inProgress',
  };
}

/**
 * The multi-location-update fragment that signs an action off. The stamp is
 * server-side by construction: the uid comes from the verified token and the
 * time from the Function's clock, never the payload. A completion note (story
 * 2044 AC2), when supplied, records HOW the action was resolved; it is only
 * written when present so an unnoted sign-off leaves the field absent. The
 * optional evidence document behaves the same way, and arrives here already
 * validated against the caller's own tenant Storage prefix.
 */
export function signOffFragment(
  actionPath: string,
  byUid: string,
  now: number,
  completionNote?: string,
  completionEvidence?: SafentiaDocument,
): Record<string, unknown> {
  return {
    [`${actionPath}/status`]: 'signedOff',
    [`${actionPath}/signedOffBy`]: byUid,
    [`${actionPath}/signedOffAt`]: now,
    ...(completionNote !== undefined
      ? { [`${actionPath}/completionNote`]: completionNote }
      : {}),
    ...(completionEvidence !== undefined
      ? { [`${actionPath}/completionEvidence`]: completionEvidence }
      : {}),
  };
}

/** Reopening clears the sign-off provenance, the completion note, its evidence
 *  AND the customer's own progress claim entirely (null deletes in RTDB) - a
 *  reopened action is open again and must not carry a stale stamp, proof a later
 *  sign-off could be confused with, or a customer's "this is done" against work
 *  the organisation has just judged unfinished. Nothing is lost: the
 *  status-history entries that recorded them all keep their copies. */
export function reopenFragment(actionPath: string): Record<string, unknown> {
  return {
    [`${actionPath}/status`]: 'open',
    [`${actionPath}/signedOffBy`]: null,
    [`${actionPath}/signedOffAt`]: null,
    [`${actionPath}/completionNote`]: null,
    [`${actionPath}/completionEvidence`]: null,
    [`${actionPath}/customerResponse`]: null,
  };
}

/**
 * The multi-location-update fragment that records a CUSTOMER's own account of
 * progress (respondToAction). Two deliberate limits define it:
 *
 *   - it writes `customerResponse` and, at most, a status of 'inProgress'. It
 *     can never write 'signedOff', `signedOffBy` or `signedOffAt`, so a
 *     duty-holder cannot close their own compliance record however the callable
 *     above it is called. Verification stays with the organisation.
 *   - the status is only moved when the action is still 'open': a customer
 *     saying work is under way IS the same fact staff record with `start`, but
 *     an action already in progress must not be rewritten to the same value on
 *     every note.
 */
export function customerResponseFragment(
  actionPath: string,
  response: ActionCustomerResponse,
  moveToInProgress: boolean,
): Record<string, unknown> {
  return {
    [`${actionPath}/customerResponse`]: response,
    ...(moveToInProgress ? { [`${actionPath}/status`]: 'inProgress' } : {}),
  };
}

/**
 * The multi-location-update fragment that appends ONE status-change entry to an
 * action's history (story 2044 AC3), oldest first.
 *
 * Lost-update safety: the entry is written BY INDEX at the current length, never
 * by rewriting the whole array. A stale read can therefore only ever fail to
 * reserve a fresh slot (two near-simultaneous appends racing for the same index,
 * bounded here by the admin-only, rate-limited caller); it can never drop an
 * entry a concurrent change already wrote, which a read-modify-write of the
 * entire array from a stale copy would. RTDB reconstructs the contiguous numeric
 * keys back into the `ActionStatusChange[]` the contract types.
 */
export function statusHistoryAppendFragment(
  actionPath: string,
  existing: Pick<Action, 'statusHistory'>,
  entry: ActionStatusChange,
): Record<string, unknown> {
  const nextIndex = existing.statusHistory?.length ?? 0;
  return {
    [`${actionPath}/statusHistory/${nextIndex}`]: entry,
  };
}
