// ============================================================================
// guideSeen - the record of "this person has read how validation works", so the
// explainer introduces itself once rather than on every assessment.
//
// localStorage and not consoleState/{uid}: this is a view preference, not org
// data. FloatingGettingStarted makes the same call for the same reason - growing
// the stored console schema for a dismissible panel would be over-engineering
// next to the honest state that node exists for. Per DEVICE rather than per tab
// (the spaceChoice idiom is sessionStorage because a picker SHOULD ask again in
// a new tab; an explainer should not), and per uid, so a shared machine
// introduces the next auditor properly.
//
// Every access is guarded: Safari's private mode and locked-down enterprise
// profiles throw on storage access, and a panel that crashes the review screen
// is a far worse failure than one that says hello a second time.
// ============================================================================

const PREFIX = 'safentia.validationGuideSeen.';

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** True when this auditor has already dismissed the explainer on this device. */
export function hasSeenValidationGuide(uid: string): boolean {
  try {
    return storage()?.getItem(PREFIX + uid) === '1';
  } catch {
    return false;
  }
}

/** Record the dismissal, so the explainer collapses to its "How this works"
 *  button from the next assessment on. */
export function rememberValidationGuideSeen(uid: string): void {
  try {
    storage()?.setItem(PREFIX + uid, '1');
  } catch {
    // Storage unavailable: the explainer simply opens again next time, which is
    // correct behaviour rather than a failure worth surfacing.
  }
}
