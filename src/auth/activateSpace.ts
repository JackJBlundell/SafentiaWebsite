// ============================================================================
// activateSpace - the ONE way the client changes which space it is acting in.
//
// The callable re-verifies membership server-side and re-mints the custom
// claims: a staff space mints `orgId`, a portal space mints
// `portalOrgId` + `customerId`, never both, so switching halves is a re-mint and
// not a second set of claims held alongside. Nothing here decides anything -
// the client cannot grant itself a space, and this wrapper exists so that fact
// is stated in one place rather than re-implemented by the picker, the switcher
// and the invitation page.
//
// Callers must `refreshSession()` afterwards: the claims have changed, but the
// browser is still holding the token minted before they did.
// ============================================================================

import { httpsCallable } from 'firebase/functions';
import { firebase } from '../firebase';
import type {
  SetActiveOrganisationInput,
  SetActiveOrganisationResult,
} from '../types';

export async function activateSpace(
  orgId: string,
  customerId?: string,
): Promise<void> {
  const call = httpsCallable<
    SetActiveOrganisationInput,
    SetActiveOrganisationResult
  >(firebase.functions(), 'setActiveOrganisation');
  // `customerId` is omitted rather than sent as undefined: its PRESENCE is what
  // selects the portal half, so an explicit undefined would be a wire-level lie.
  // The result is not read - the freshly minted claims, not the echo, are the
  // truth, and the caller's refreshSession() is what fetches them.
  await call(customerId ? { orgId, customerId } : { orgId });
}
