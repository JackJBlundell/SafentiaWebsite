// ============================================================================
// respondToAction (callable, customer portal) - the duty-holder tells their
// provider how the remedial work is going.
//
// The action plan is work the CUSTOMER is responsible for arranging and the
// ORGANISATION is responsible for verifying. Until now the portal only showed
// it, so a customer who had already fixed something had no way to say so and
// staff had no way to know. This callable closes that gap - and only that gap.
//
// THE DIVISION OF AUTHORITY IS THE WHOLE POINT. A response records a CLAIM:
// `customerResponse` on the record, an entry in the action's statusHistory
// attributed to the portal uid, and at most a move to 'inProgress' (the same
// working state staff's `start` verb writes). It can never write 'signedOff',
// `signedOffBy` or `signedOffAt` - those live in manageAction's sign-off verb,
// behind an org-admin gate - because a duty-holder signing off their own fire
// safety compliance would make the record worthless. The copy on both sides
// says so in words: the portal promises verification, the console asks for it.
//
// Trust boundary, mirroring acceptReport: NOTHING about who the caller is or
// what they may reach comes from the payload. The org and customer come from
// the verified portal token; the building's owning customer is re-derived from
// /{env}/buildingCustomerIndex at request time (a building that has changed
// hands must not still be writable by the previous customer); and the caller's
// portal seat is re-read from /customerMembers, so a locked account, an archived
// customer or a removed member is refused immediately rather than when their ID
// token eventually refreshes.
// ============================================================================

import { onCall } from 'firebase-functions/v2/https';
import { db } from '../admin';
import { callableOptions } from '../lib/callable';
import { createLogger } from '../lib/logging';
import { fail, runCallable } from '../lib/errors';
import {
  assertAppCheck,
  assertAuth,
  getPortalClaims,
  envFor,
} from '../lib/guards';
import {
  assertObject,
  optionalString,
  requireDbKey,
  requireEnum,
  TEXT_LIMITS,
} from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { activityUpdate } from '../lib/events';
import {
  customerResponseFragment,
  statusHistoryAppendFragment,
} from '../lib/actionPlan';
import {
  ACTION_RESPONSE_STATES,
  CUSTOMER_ROLES,
  type Action,
  type ActionCustomerResponse,
  type ActionStatusChange,
  type CustomerMember,
  type CustomerRole,
  type CustomerRoleSet,
  type RespondToActionInput,
  type RespondToActionResult,
} from '../shared/types';

/**
 * WHICH PORTAL ROLES MAY RECORD PROGRESS ON AN ACTION. This table is the ONLY
 * thing that decides, so tightening or loosening it is a one-line change here.
 *
 * A `viewer` is excluded by name: their seat exists to READ the customer's fire
 * safety position, and a completion claim is a statement the organisation will
 * act on. `finance` is included today because they act on the account's behalf
 * and are frequently the person who commissioned the contractor; if the product
 * decides otherwise, flip it to false and nothing else in the codebase moves.
 */
const PORTAL_ROLE_MAY_RESPOND: Record<CustomerRole, boolean> = {
  admin: true,
  finance: true,
  viewer: false,
};

/** A member carrying no role flags at all - a record predating roles, or one
 *  whose roles were cleared - is judged as the LEAST-privileged seat rather than
 *  waved through, so an empty role set can never become a quiet way past the
 *  table above (the same posture getReportDownloadUrl takes). */
const DEFAULT_PORTAL_ROLE: CustomerRole = 'viewer';

/** Does this member's LIVE role set permit a response? Roles come from the
 *  /customerMembers record rather than the token, because the token is a cached
 *  copy that can be minutes stale and this is the authorisation decision. Only
 *  a literal `true` on a known role counts (the defensive reconstruction
 *  computePortalClaims applies), so a malformed record cannot assert a role. */
function portalRoleMayRespond(roles: CustomerRoleSet | undefined): boolean {
  const held = CUSTOMER_ROLES.filter(
    (role) => (roles as Record<string, unknown> | undefined)?.[role] === true,
  );
  const effective: readonly CustomerRole[] =
    held.length > 0 ? held : [DEFAULT_PORTAL_ROLE];
  return effective.some((role) => PORTAL_ROLE_MAY_RESPOND[role]);
}

export const respondToAction = onCall<RespondToActionInput>(
  callableOptions,
  (request) =>
    runCallable<RespondToActionResult>(
      createLogger({ fn: 'respondToAction' }),
      async () => {
        // 1. Attestation, identity, rate limit, then the PORTAL identity (a
        // staff token resolves to nothing here - the two claim shapes are
        // disjoint, so a staff member cannot reach this verb at all).
        assertAppCheck(request);
        const { uid } = assertAuth(request);
        await assertRateLimit(uid, 'respondToAction');
        const claims = getPortalClaims(request);
        const { paths } = envFor(claims);
        const orgId = claims.orgId;
        const customerId = claims.customerId;

        // 2. Validate the input. The two ids are interpolated into database
        // paths, so they are validated as KEYS: a value carrying `/` would
        // address a node one level deeper than intended and let the response
        // land on a sibling field.
        const input = assertObject(request.data);
        const buildingId = requireDbKey(input, 'buildingId', TEXT_LIMITS.shortText);
        const actionId = requireDbKey(input, 'actionId', TEXT_LIMITS.shortText);
        const state = requireEnum(input, 'state', ACTION_RESPONSE_STATES);
        // Free text, length-capped and trimmed; an empty note reads as no note.
        const note = optionalString(input, 'note', TEXT_LIMITS.freeText);

        // A single refusal for every authorisation failure below. Telling the
        // caller WHICH check failed would let a portal account probe another
        // customer's building ids, and none of the distinctions are actionable
        // by them anyway - the recovery is the same conversation every time.
        const denied = () =>
          fail.permissionDenied('You do not have access to this action.');

        // 3a. The building must belong to the caller's OWN customer, derived
        // from the reverse index NOW rather than trusted from the client or
        // inferred from the action record.
        const ownerSnap = await db
          .ref(paths.db.buildingCustomer(orgId, buildingId))
          .get();
        if ((ownerSnap.val() as string | null) !== customerId) {
          throw denied();
        }

        // 3b. Their portal seat must still be live, and carry a role allowed to
        // speak for the customer. Read from the record, not the token.
        const member = (
          await db.ref(paths.db.customerMember(orgId, customerId, uid)).get()
        ).val() as CustomerMember | null;
        if (member?.status !== 'active') {
          throw denied();
        }
        if (!portalRoleMayRespond(member.roles)) {
          throw fail.permissionDenied(
            'Your portal account can view this action plan but cannot record progress on it. Ask one of your portal administrators.',
          );
        }

        // 4. Load the action. Actions are scoped by building (the unit a
        // customer reads), which is why the input carries the building too.
        const actionPath = paths.db.action(orgId, buildingId, actionId);
        const existing = (await db.ref(actionPath).get()).val() as Action | null;
        if (!existing) {
          throw fail.notFound('That action could not be found.', {
            field: 'actionId',
          });
        }
        // Only live work can be responded to. A signed-off action has already
        // been verified and closed by the organisation, and an archived one is
        // out of the plan; in both cases a further claim would be noise against
        // a settled record, so it is refused with copy that says which it is.
        if (existing.status === 'signedOff') {
          throw fail.failedPrecondition(
            'Your provider has already signed this action off, so there is nothing left to report.',
          );
        }
        if (existing.status !== 'open' && existing.status !== 'inProgress') {
          throw fail.failedPrecondition(
            'This action is no longer part of the active plan.',
          );
        }

        // 5. Write the response, the trail entry and the audit entry in ONE
        // multi-location update, so a claim can never land without the record of
        // who made it - the same discipline manageAction holds staff to.
        const now = Date.now();
        const response: ActionCustomerResponse = {
          state,
          byUid: uid,
          at: now,
          ...(note !== undefined ? { note } : {}),
        };
        // Open work becomes in progress on any response: the customer has told
        // us the work has started or finished, and 'inProgress' is a working
        // state, not a closure. 'completed' stops there too - the action waits
        // at in-progress for a staff member to verify and sign it off.
        const moveToInProgress = existing.status === 'open';
        const historyEntry: ActionStatusChange = {
          status: moveToInProgress ? 'inProgress' : existing.status,
          byUid: uid,
          at: now,
          // `response` is what marks this entry as the CUSTOMER's claim rather
          // than a staff move, so the one trail reads honestly on both sides.
          response: state,
          ...(note !== undefined ? { note } : {}),
        };

        await db.ref().update({
          ...customerResponseFragment(actionPath, response, moveToInProgress),
          ...statusHistoryAppendFragment(actionPath, existing, historyEntry),
          ...activityUpdate(paths, orgId, {
            actorUid: uid,
            action: 'action.customerResponded',
            target: actionId,
          }),
        });

        createLogger({ fn: 'respondToAction', orgId }).info(
          'Customer responded to an action',
          { buildingId, actionId, state },
        );
        return { respondedAt: now };
      },
    ),
);
