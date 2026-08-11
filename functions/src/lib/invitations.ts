// ============================================================================
// Invitation issue core - shared by createInvitation and manageCustomer - plus
// the token lookup shared by previewInvitation and acceptInvitation.
//
// Minting an invitation is three inseparable steps: a crypto-random bearer
// token, the env-scoped record plus its admin-facing /orgInvitations summary
// (written in ONE update so the two can never drift), and the branded email
// carrying the accept link. createInvitation does this for staff and ad-hoc
// portal invites; manageCustomer does it when auto-inviting a new customer's
// primary contact. Centralising it here keeps the token discipline (never
// logged, never copied into the summary - brief 18.4) in exactly one place.
//
// Guards live with the CALLERS, deliberately: each callable owns its own
// attestation, role checks, input validation and plan-limit posture, and this
// module only ever runs after those have passed.
// ============================================================================

import { db } from '../admin';
import { generateToken } from './callable';
import { orgEmailBrand } from './emailTemplates';
import { sendKindEmail } from './templatedEmail';
import { WEB_ORIGIN } from './webOrigin';
import { paths, type EnvPaths } from './paths';
import type { Logger } from './logging';
import { ENVIRONMENTS } from '../shared/types';
import type {
  Environment,
  Invitation,
  InvitationSummary,
  OrgProfile,
  OrgRoleSet,
} from '../shared/types';

/** Invitations expire after seven days - long enough to action, short enough that
 *  a leaked link does not stay live indefinitely. Stored as epoch millis.
 *  resendInvitation mints replacement links with the same TTL. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface IssueInvitationArgs {
  env: Environment;
  paths: EnvPaths;
  orgId: string;
  /** The admin uid the summary records as the inviter. */
  invitedBy: string;
  email: string;
  roles: OrgRoleSet;
  /** Customer-portal scope: the customer this invite joins the recipient to. */
  customerId?: string;
  /** The CustomerContact the portal invite belongs to; acceptInvitation writes
   *  the accepted account's uid back onto that contact. */
  contactId?: string;
  logger: Logger;
}

export interface IssuedInvitation {
  inviteId: string;
  expiresAt: number;
}

/** The invitation expiry rendered for the {{invite.expiry}} template variable,
 *  UK-local so it names the day the recipient's own calendar shows. */
function formatExpiryDate(millis: number): string {
  return new Date(millis).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/London',
  });
}

export interface SendInvitationEmailArgs {
  env: Environment;
  paths: EnvPaths;
  orgId: string;
  /** The recipient - the invited address the token was minted for. */
  email: string;
  /** The CURRENT bearer token; it travels only inside the accept links. */
  token: string;
  expiresAt: number;
  logger: Logger;
}

/**
 * Dispatch the branded invitation email through the templating seam (kind
 * 'invitation'). The token travels in the accept link. The PRIMARY link is the
 * web acceptance page at /invite, which works on any device with a browser;
 * acceptInvitation locates the token across both env roots server-side, so the
 * web link needs no env parameter. The app deep link rides along as a secondary
 * option (it carries the env so the app lands in the right data root, 4.8).
 *
 * Shared by issueInvitation and resendInvitation so the first send and every
 * rotation carry the same copy - the catalogue's 'invitation' default (or the
 * org's own template where one is saved).
 */
export async function sendInvitationEmail({
  env,
  paths,
  orgId,
  email,
  token,
  expiresAt,
  logger,
}: SendInvitationEmailArgs): Promise<void> {
  const acceptLink = `${WEB_ORIGIN}/invite?token=${encodeURIComponent(token)}`;
  const appLink = `safentia://invite?token=${encodeURIComponent(
    token,
  )}&env=${env}`;
  // The invite carries the inviting organisation's own brand (name + accent),
  // falling back to the Safentia brand when the org has not set a valid one.
  const profileSnap = await db.ref(paths.db.orgProfile(orgId)).get();
  const brand = orgEmailBrand(profileSnap.val() as OrgProfile | null);
  await sendKindEmail(
    {
      kind: 'invitation',
      env,
      orgId,
      to: email,
      variables: {
        'org.name': brand.name,
        'recipient.email': email,
        'invite.url': acceptLink,
        'invite.expiry': formatExpiryDate(expiresAt),
        'invite.appUrl': appLink,
      },
      brand,
      kindLink: acceptLink,
    },
    logger,
  );
}

/**
 * Create an env-scoped, tokenised, expiring invitation and dispatch the branded
 * invite email. The record and its admin-facing summary land in the SAME
 * multi-location update; the token is NEVER copied into the summary, so a
 * summary read can never accept on the recipient's behalf. A failed or skipped
 * email send never rolls back the (security-critical) record - the admin
 * resends instead.
 */
export async function issueInvitation({
  env,
  paths,
  orgId,
  invitedBy,
  email,
  roles,
  customerId,
  contactId,
  logger,
}: IssueInvitationArgs): Promise<IssuedInvitation> {
  // The env-scoped invitation record. push() gives the invite id.
  const ref = db.ref(paths.db.invitations()).push();
  const inviteId = ref.key as string;
  const expiresAt = Date.now() + INVITATION_TTL_MS;
  const token = generateToken();

  const invitation: Invitation = {
    orgId,
    email,
    roles,
    token,
    expiresAt,
    status: 'pending',
    ...(customerId ? { customerId } : {}),
    ...(contactId ? { contactId } : {}),
  };

  // The admin-facing summary lives under /orgInvitations (readable by the
  // org's admins - the /invitations root never is, because it carries the
  // bearer token). Written in the SAME update as the record so the two
  // cannot drift.
  const summary: InvitationSummary = {
    email,
    roles,
    status: 'pending',
    expiresAt,
    createdAt: Date.now(),
    invitedBy,
    ...(customerId ? { customerId } : {}),
    ...(contactId ? { contactId } : {}),
  };
  await db.ref().update({
    [paths.db.invitation(inviteId)]: invitation,
    [paths.db.orgInvitation(orgId, inviteId)]: summary,
  });

  // Email dispatch through the templating seam (see sendInvitationEmail for
  // the link discipline). Best-effort by the seam's own contract, so a failed
  // send never rolls back the record above.
  await sendInvitationEmail({ env, paths, orgId, email, token, expiresAt, logger });

  return { inviteId, expiresAt };
}

/** An invite located in a specific env root, with its db key. */
export interface LocatedInvite {
  env: Environment;
  inviteId: string;
  invitation: Invitation;
}

/**
 * Find the invite carrying this token. Invitations are env-scoped, and the
 * recipient holds only the token, so we query each env root's /invitations by
 * the indexed `token` child (the rules declare .indexOn token). The first match
 * wins; a token is unique by construction (crypto-random 32 bytes).
 *
 * Shared by previewInvitation and acceptInvitation so the two can never disagree
 * about which record a given token names.
 */
export async function locateInviteByToken(
  token: string,
): Promise<LocatedInvite | null> {
  for (const env of ENVIRONMENTS) {
    const envPaths = paths.forEnv(env);
    const snap = await db
      .ref(envPaths.db.invitations())
      .orderByChild('token')
      .equalTo(token)
      .limitToFirst(1)
      .get();
    if (snap.exists()) {
      const value = snap.val() as Record<string, Invitation>;
      const [inviteId, invitation] = Object.entries(value)[0];
      return { env, inviteId, invitation };
    }
  }
  return null;
}
