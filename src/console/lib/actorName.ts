// ============================================================================
// actorName - the one way a uid becomes a display name in the console.
//
// Activity rows, job assignments and validation entries store the actor's uid
// (immutable, survives renames); the display name is resolved at render time
// from the /orgMembers map. Before this helper each screen fell back to the RAW
// uid, so a departed member's history rendered as "a8Xk92...". The honest
// states are:
//   - the member exists          -> their name;
//   - the uid is a CUSTOMER PORTAL account -> their name, marked "(customer)".
//     Portal people appear in the trail for real reasons - accepting a report,
//     inviting a colleague - and calling them a former staff member would put a
//     false attribution in an audit record someone may one day rely on;
//   - members loaded, uid absent -> "Former staff member" (removed/archived
//     members are deleted from /orgMembers but their history rows remain);
//   - members still loading      -> a neutral ellipsis, never a uid flash.
//
// The `loaded` flag is the caller's query state (data !== undefined), passed
// explicitly because the members read is role-gated: a screen whose viewer
// cannot read /orgMembers at all stays "loading" forever, and the ellipsis is
// still the right render there - a uid would leak an identifier the viewer has
// no path to resolving.
// ============================================================================

import { SYSTEM_ACTOR_UID } from '../../types';
import type { OrgMember } from '../../types';

/** What a name-resolving screen needs from the members map; kept structural so
 *  callers with partial member records still type-check. */
export type MembersByUid = Record<string, Pick<OrgMember, 'name'>>;

/** Neutral placeholder while the members map is in flight (or unreadable). */
const LOADING_PLACEHOLDER = '…';

/** Shown when the members map is loaded but the uid is not in it - the member
 *  has been removed from the organisation; their recorded history remains. */
export const FORMER_STAFF_LABEL = 'Former staff member';

/** Shown for activity the PLATFORM performed - a scheduled sweep archiving a
 *  customer whose contract ended. Naming it honestly matters in an audit trail:
 *  without this the system uid falls through to "Former staff member", which
 *  reads as a person having done it. */
export const SYSTEM_ACTOR_LABEL = 'Safentia (automatic)';

export function actorName(
  members: MembersByUid | null | undefined,
  uid: string,
  loaded: boolean,
  /** The organisation's CUSTOMER-portal accounts, flattened uid -> name. Pass
   *  it on any screen where a portal person can appear in the trail. */
  portalMembers?: MembersByUid | null,
): string {
  if (uid === SYSTEM_ACTOR_UID) {
    return SYSTEM_ACTOR_LABEL;
  }
  const name = members?.[uid]?.name;
  if (name) {
    return name;
  }
  const portalName = portalMembers?.[uid]?.name;
  if (portalName) {
    return `${portalName} (customer)`;
  }
  return loaded ? FORMER_STAFF_LABEL : LOADING_PLACEHOLDER;
}
