// ============================================================================
// Second demo organisation - the multi-org / org-switch demonstration.
//
// The primary assessor (Alex Mercer) belongs to BOTH this organisation and the
// main Safentia demo org. Signing in as Alex lands in the main org; the Account
// screen's organisation switcher then flips the whole app - including the
// per-org whitelabel THEME (brief 9.1) - to this org, which carries a deliberately
// DISTINCT brand (royal purple + teal vs the main org's blue + amber) so the
// switch is unmistakable on screen.
//
// The org is given a small but COMPLETE slice (its own customer -> site ->
// building, the published PAS 79 template, and one scheduled job assigned to
// Alex), so switching into it shows a real, themed, populated app rather than an
// empty shell. Brand colours stay clear of the RAG semantic palette (red/amber/
// green), which brand tokens must never override (brief 9.1).
// ============================================================================

import type {
  Organisation,
  Customer,
  CustomerContact,
  Site,
  Building,
  Job,
} from '../../shared/types';
import type { SeedMember } from './members';
import {
  ORG2,
  UID,
  EMAIL_DOMAIN,
  PAS79_TEMPLATE_ID,
  PAS79_TEMPLATE_VERSION,
  days,
} from '../ids';

/** The distinct brand colours for org2 (kept clear of the RAG palette). */
export const ORG2_BRAND = { primary: '#5B2A86', secondary: '#0FB5BA' } as const;

/** Build the org2 record. `logoUrl` is injected after upload so the profile and
 *  the stored object never drift (same contract as the main org). */
export function buildOrganisation2(logoUrl: string): Organisation {
  return {
    profile: {
      name: 'Aegis Fire Protection',
      logoUrl,
      brand: { ...ORG2_BRAND },
      fontFamily: 'Inter',
      contact: {
        name: 'Aegis Operations',
        email: 'assessments@aegis-demo.test',
        phone: '+44 121 496 0440',
        address: '8 Brindleyplace, Birmingham, B1 2JB',
      },
    },
    usage: {
      staffCount: 1,
      customerCount: 1,
      notificationsThisMonth: 0,
    },
  };
}

// Alex is the SAME demo account (same uid + email) as in the main org, so the
// seed resolves him to the same Firebase Auth user - that is what makes him a
// genuine member of two organisations. We do NOT set his active-org claim here;
// he stays active in the main org and switches via setActiveOrganisation.
export const ORG2_MEMBERS: SeedMember[] = [
  {
    uid: UID.assessor,
    member: {
      roles: { assessor: true },
      testMode: true,
      name: 'Alex Mercer',
      email: `alex.assessor@${EMAIL_DOMAIN}`,
      status: 'active',
    },
  },
];

export const ORG2_CUSTOMER: Customer = {
  name: 'Vantage Properties Ltd',
  email: 'facilities@vantage-properties.test',
  phone: '+44 121 496 0441',
  score: 66,
  status: 'active',
};

// The customer's single (and therefore primary) contact; the site and the
// building's responsible-party snapshot both reference this id.
export const ORG2_CONTACT_ID = 'contact-vantage-olivia-grant';
export const ORG2_CONTACT: CustomerContact = {
  name: 'Olivia Grant',
  email: 'olivia.grant@vantage-properties.test',
  phone: '+44 121 496 0441',
  jobTitle: 'Facilities Director',
  portalRoles: { admin: true },
  isPrimary: true,
  createdAt: days(-90),
};

export const ORG2_SITE: Site = {
  name: 'Vantage Quarter',
  address: 'Brindleyplace, Birmingham, B1 2JB',
  geo: { lat: 52.4796, lng: -1.9119 },
  contactId: ORG2_CONTACT_ID,
};

/** Build org2's single building. `photoUrl` is injected after upload. A complete
 *  record (details + service schedule) so the building reads as real. It is
 *  awaiting its FIRST assessment under the scheduled job, so its risk is
 *  honestly 'pending' and it carries NO ragDistribution at all - per the
 *  ragDerivation semantics a never-assessed building has an absent
 *  distribution, never fabricated (or zeroed) counts. */
export function buildOrg2Building(photoUrl: string): Building {
  return {
    name: 'Vantage House',
    customerId: ORG2.customer,
    address: 'Brindleyplace, Birmingham, B1 2JB',
    details: {
      area: 4300,
      floors: 6,
      occupiedFloors: 6,
      occupants: 210,
      isLandlord: true,
      alarmType: 'Addressable analogue',
      alarmCategory: 'L2',
    },
    responsibleParty: {
      name: 'Olivia Grant',
      role: 'Facilities Director',
      email: 'olivia.grant@vantage-properties.test',
      phone: '+44 121 496 0441',
      contactId: ORG2_CONTACT_ID,
    },
    article53Persons: ['Vantage Properties Ltd'],
    photoUrl,
    riskLevel: 'pending',
    serviceSchedule: {
      fireAlarmService: { nextDue: days(60) },
      fireMarshalTraining: { nextDue: days(140) },
      fireSafetyTraining: { nextDue: days(95) },
      fireDrill: { nextDue: days(80) },
      pat: { nextDue: days(180) },
      extinguisherMaintenance: { nextDue: days(40) },
      fraReview: { nextDue: days(300) },
    },
  };
}

/** org2's single job: scheduled, assigned to Alex, pinned to the PAS 79 template
 *  (story 1031), so the Jobs tab is populated the moment Alex switches in. */
export const ORG2_JOB: Job = {
  templateId: PAS79_TEMPLATE_ID,
  templateVersion: PAS79_TEMPLATE_VERSION,
  customerId: ORG2.customer,
  siteId: ORG2.site,
  buildingId: ORG2.building,
  assessorUid: UID.assessor,
  scheduledFor: days(2),
  status: 'scheduled',
};
