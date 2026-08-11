// ============================================================================
// useOrgEmailBrand - the EmailBrand the console's email previews dress in.
//
// Mirrors the server's orgEmailBrand derivation (functions/src/lib/
// emailTemplates.ts) so what the admin previews is what the recipient gets:
// the organisation's own name and a VALIDATED #rrggbb accent from its profile,
// falling back per-field to the Safentia platform brand when the org has not
// set a valid value. The profile read is the shared orgProfile subscription,
// so this costs nothing a themed screen has not already paid.
// ============================================================================

import { useOrgScope } from '../customers/shared';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type { OrgProfile } from '../../types';
import { SAFENTIA_BRAND, type EmailBrand } from './emailHtml';

/** The server's guard, kept in step by hand: a full six-digit hex colour. */
const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

/** The org's email brand, or the platform brand until the profile arrives
 *  (previews opened that early simply show Safentia dress for a moment). */
export function useOrgEmailBrand(): EmailBrand {
  const { ready, orgId, db } = useOrgScope();
  const profile = useRtdbQuery<OrgProfile | null>({
    key: keys.orgProfile(orgId),
    path: db?.orgProfile(orgId) ?? '',
    enabled: ready,
  });

  const name = profile.data?.name;
  const primary = profile.data?.brand?.primary;
  return {
    name: typeof name === 'string' && name.trim() !== '' ? name : SAFENTIA_BRAND.name,
    accent:
      typeof primary === 'string' && HEX_COLOUR.test(primary)
        ? primary
        : SAFENTIA_BRAND.accent,
  };
}
