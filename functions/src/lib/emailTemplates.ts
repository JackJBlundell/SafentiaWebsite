// ============================================================================
// Branded email rendering - server entry point.
//
// The renderer itself now lives in ./emailHtml, a self-contained pure module
// mirrored byte-for-byte from `src/console/emails/emailHtml.ts` (the
// ragDerivation.ts pattern) so the console's live previews are byte-identical
// to the delivered email. This module is the thin server-side wrapper: it
// re-exports everything the renderer provides, so existing imports keep
// working unchanged, and adds the one piece that cannot be mirrored -
// orgEmailBrand, which turns a stored OrgProfile (an RTDB read) into the
// EmailBrand an org-scoped email is dressed in.
// ============================================================================

import type { OrgProfile } from '../shared/types';
import { SAFENTIA_BRAND } from './emailHtml';
import type { EmailBrand } from './emailHtml';

export * from './emailHtml';
export type {
  EmailBrand,
  EmailDetailRow,
  EmailCta,
  BrandedEmailOptions,
} from './emailHtml';

/** Exactly #RRGGBB. Mirrors the guard updateOrgProfile enforces on write and the
 *  report renderer applies on read, so a malformed stored colour can never reach
 *  the template (an unguarded value would poison the header bar / button style). */
const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

/**
 * Build the EmailBrand an org-scoped email should carry from the sending
 * organisation's profile: its OWN name and accent when both are set to valid
 * values, falling back per-field to the Safentia platform brand when the org
 * has not set a valid one. `profile` is whatever the RTDB read returned, so it
 * is read defensively (a remote record may be null or partial).
 */
export function orgEmailBrand(profile: OrgProfile | null | undefined): EmailBrand {
  const primary = profile?.brand?.primary;
  const name = profile?.name;
  return {
    name: typeof name === 'string' && name.trim() !== '' ? name : SAFENTIA_BRAND.name,
    accent:
      typeof primary === 'string' && HEX_COLOUR.test(primary)
        ? primary
        : SAFENTIA_BRAND.accent,
  };
}
