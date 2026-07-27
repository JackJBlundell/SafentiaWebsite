// ============================================================================
// The canonical public web origin.
//
// ONE source of truth for the live site's origin, shared by every email that
// links a recipient back into the browser experience (invitation accept links,
// the customer's released-report portal CTA). The live site is safentia.co.uk
// (see webConfig.siteUrl in the web app's src/config/env.ts); keeping a single
// constant here means an origin move is a one-line change, never a hunt through
// hardcoded literals that drift apart. The app deep-link scheme (safentia://)
// is deliberately NOT here - it is a separate, unversioned concern.
// ============================================================================

export const WEB_ORIGIN = 'https://safentia.co.uk';
