// ============================================================================
// The single demo organisation (brief 10).
//
// A complete profile: brand colours (a tasteful primary + secondary), a font
// family, a logo and full contact details, so the app's per-org whitelabel
// theming (brief 9.1) is demonstrable the moment an assessor signs in. The logo
// URL is filled in by the seed once the real logo PNG has been uploaded to the
// env-scoped Storage path.
// ============================================================================

import type { Organisation } from '../../shared/types';

/** Build the organisation record. `logoUrl` is injected after upload so the
 *  profile and the actual stored object never drift. */
export function buildOrganisation(logoUrl: string): Organisation {
  return {
    profile: {
      name: 'Safentia Fire Safety',
      logoUrl,
      brand: {
        // A clean, confident medium blue with a deep-navy accent - reads as a
        // serious safety brand while staying clearly distinct from the RAG
        // semantic colours, which brand tokens must never override (brief 9.1).
        primary: '#2563EB',
        secondary: '#1E3A8A',
      },
      fontFamily: 'Inter',
      contact: {
        name: 'Safentia Operations',
        email: 'assessments@firerite-demo.test',
        phone: '+44 20 7946 0123',
        address: '14 Kingsway, London, WC2B 6LH',
      },
    },
    // Counters the platform maintains. Seeded to match what we create below so
    // the org dashboard (Phase 2) reads true totals from the start.
    usage: {
      staffCount: 6,
      customerCount: 3,
      notificationsThisMonth: 0,
    },
  };
}
