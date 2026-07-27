// ============================================================================
// spaceChoice - the record of "this person has already said where they want to
// be", so the space picker asks once rather than on every navigation.
//
// Deliberately sessionStorage and not the query cache or a claim:
//   - it is a UI preference, never a permission (the claims decide what may be
//     read, and only the setActiveOrganisation callable can change them);
//   - per TAB and per uid, so opening the console in a new tab, or signing in
//     as somebody else on a shared machine, asks again - while a reload keeps
//     the person where they were working.
//
// Every access is guarded: Safari's private mode and locked-down enterprise
// profiles throw on storage access, and a picker that crashes the console is a
// far worse failure than one that asks a second time.
// ============================================================================

const PREFIX = 'safentia.spaceChosen.';

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** True when this account has already chosen a space in this tab. */
export function hasChosenSpace(uid: string): boolean {
  try {
    return storage()?.getItem(PREFIX + uid) === '1';
  } catch {
    return false;
  }
}

/** Record that the account has chosen, so the picker steps out of the way. */
export function rememberSpaceChoice(uid: string): void {
  try {
    storage()?.setItem(PREFIX + uid, '1');
  } catch {
    // Storage unavailable: the picker simply asks again next time, which is
    // correct behaviour rather than a failure worth reporting.
  }
}

/** Drop the record, so the next console load asks again. Used when a switch we
 *  attempted on the person's behalf failed: the membership exists, but we
 *  cannot claim they landed anywhere, so the picker must have the last word. */
export function forgetSpaceChoice(uid: string): void {
  try {
    storage()?.removeItem(PREFIX + uid);
  } catch {
    // As above: nothing stored means nothing to forget.
  }
}
