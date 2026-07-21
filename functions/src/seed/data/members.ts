// ============================================================================
// Organisation members (brief 10).
//
// One member per org role (admin, assessor, auditor, finance, viewer) plus one
// user holding TWO roles (admin + assessor) to prove the union-permission model.
// Every member is a TEST user (`testMode: true`) because the whole seed lives
// under /test (brief 4.8); onMembershipChange copies that marker into the user's
// custom claim, routing them to /test - the seed sets nothing on the client.
//
// Each member also has a matching Firebase Auth user (created by the seed with a
// deterministic uid and a known password) so a human can actually sign in and
// exercise the app. The assessor is the primary login for Phase 1.
// ============================================================================

import type { OrgMember, OrgRoleSet } from '../../shared/types';
import { UID, EMAIL_DOMAIN } from '../ids';

/** A seed member paired with its Auth uid and password, so the writer can both
 *  create the Auth user and write the /orgMembers record from one source. */
export interface SeedMember {
  uid: string;
  member: OrgMember;
}

function member(
  uid: string,
  name: string,
  localPart: string,
  roles: OrgRoleSet,
): SeedMember {
  return {
    uid,
    member: {
      roles,
      testMode: true,
      name,
      email: `${localPart}@${EMAIL_DOMAIN}`,
      status: 'active',
    },
  };
}

/** A seed member whose email is a real address (e.g. the project owner signing
 *  in with Google), rather than the demo `@firerite-demo.test` domain. */
function realMember(
  uid: string,
  name: string,
  email: string,
  roles: OrgRoleSet,
): SeedMember {
  return { uid, member: { roles, testMode: true, name, email, status: 'active' } };
}

// The assessor is declared first so the rest of the seed can reference its uid
// as the job/assessment owner without ambiguity.
export const SEED_MEMBERS: SeedMember[] = [
  member(UID.assessor, 'Alex Mercer', 'alex.assessor', { assessor: true }),
  member(UID.admin, 'Dana Okafor', 'dana.admin', { admin: true }),
  member(UID.auditor, 'Priya Shah', 'priya.auditor', { auditor: true }),
  member(UID.finance, 'Tom Reilly', 'tom.finance', { finance: true }),
  member(UID.viewer, 'Sam Webb', 'sam.viewer', { viewer: true }),
  // Multi-role: proves permission is the UNION of roles (brief 5).
  member(UID.adminAssessor, 'Jordan Blake', 'jordan.adminassessor', {
    admin: true,
    assessor: true,
  }),
  // Project owner: real Google account, holds admin + assessor so they can
  // exercise the whole app in the seeded test world.
  realMember(UID.owner, 'Jack Blundell', 'jackjblundell@gmail.com', {
    admin: true,
    assessor: true,
  }),
];

/** The member we tell the operator to sign in as. */
export const PRIMARY_ASSESSOR = SEED_MEMBERS[0];
