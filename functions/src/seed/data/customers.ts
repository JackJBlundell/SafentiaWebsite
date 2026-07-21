// ============================================================================
// Customers -> sites -> buildings (brief 10), mirroring the real hierarchy:
// an organisation has a few customers, each with a few sites, each site with
// multiple buildings.
//
// Buildings carry the FULL detail set (area, floors, occupiedFloors, occupants,
// alarm type/category, responsible person, Article 5(3) persons, photo) and a
// realistic riskLevel. Critically each building's `ragDistribution` is a TRUE
// mix - some buildings are mostly green with only a little red - so the report's
// proportional gauge can be proven NOT to skew all-red for one red item
// (story 1072, the legacy system's known failing).
//
// Floor plans exist on SOME buildings (built in floorPlans.ts) and deliberately
// NONE on at least one (the Harbourside unit) to exercise the no-floor-plan path
// in the flag feature (brief 8 step 1).
//
// Media URLs (building photos) are injected after upload so the records and the
// stored objects never drift.
// ============================================================================

import type {
  Customer,
  CustomerContact,
  CustomerMember,
  Site,
  Building,
  ResponsibleParty,
  AlarmCategory,
} from '../../shared/types';
import { CUSTOMER, CONTACT, SITE, BUILDING, days } from '../ids';

export interface SeedCustomer {
  id: string;
  customer: Customer;
}

export interface SeedSite {
  id: string;
  customerId: string;
  site: Site;
}

/** A building plus the customer/site it belongs under, so the writer can address
 *  /buildings/{org}/{site}/{building} and stamp customerId consistently. */
export interface SeedBuilding {
  id: string;
  siteId: string;
  customerId: string;
  /** Storage photo key under which this building's photo PNG is uploaded. */
  photoKey: string;
  building: Building;
}

// --- Customers ---------------------------------------------------------------
export const SEED_CUSTOMERS: SeedCustomer[] = [
  {
    id: CUSTOMER.meridian,
    customer: {
      name: 'Meridian Estates Ltd',
      email: 'facilities@meridian-estates.test',
      phone: '+44 161 496 0110',
      score: 72,
      status: 'active',
    },
  },
  {
    id: CUSTOMER.northgate,
    customer: {
      name: 'Northgate Care Group',
      email: 'compliance@northgate-care.test',
      phone: '+44 113 496 0220',
      score: 58,
      status: 'active',
    },
  },
  {
    id: CUSTOMER.harbourside,
    customer: {
      name: 'Harbourside Retail Park',
      email: 'site@harbourside-retail.test',
      phone: '+44 117 496 0330',
      score: 81,
      status: 'active',
    },
  },
];

// --- Customer contacts ---------------------------------------------------------
// The people at each customer organisation, at /customerContacts/{org}/{customer}/
// {contact}. Exactly ONE contact per customer is the primary (the invariant
// manageCustomer establishes at creation and manageCustomerContact maintains);
// sites reference these by `contactId` and buildings' responsible-party snapshots
// link back the same way.
export interface SeedCustomerContact {
  id: string;
  customerId: string;
  contact: CustomerContact;
}

export const SEED_CUSTOMER_CONTACTS: SeedCustomerContact[] = [
  {
    id: CONTACT.meridianHelen,
    customerId: CUSTOMER.meridian,
    contact: {
      name: 'Helen Carter',
      email: 'helen.carter@meridian-estates.test',
      phone: '+44 161 496 0110',
      jobTitle: 'Facilities Director',
      portalRoles: { admin: true },
      isPrimary: true,
      createdAt: days(-180),
    },
  },
  {
    id: CONTACT.meridianMarcus,
    customerId: CUSTOMER.meridian,
    contact: {
      name: 'Marcus Webb',
      email: 'marcus.webb@meridian-estates.test',
      phone: '+44 161 496 0111',
      jobTitle: 'Building Manager',
      createdAt: days(-150),
    },
  },
  {
    id: CONTACT.northgateRaymond,
    customerId: CUSTOMER.northgate,
    contact: {
      name: 'Raymond Ellis',
      email: 'raymond.ellis@northgate-care.test',
      phone: '+44 113 496 0220',
      jobTitle: 'Compliance Manager',
      portalRoles: { admin: true },
      isPrimary: true,
      createdAt: days(-160),
    },
  },
  {
    id: CONTACT.northgatePriya,
    customerId: CUSTOMER.northgate,
    contact: {
      name: 'Priya Nair',
      email: 'priya.nair@northgate-care.test',
      phone: '+44 113 496 0221',
      jobTitle: 'Registered Home Manager',
      createdAt: days(-140),
    },
  },
  {
    id: CONTACT.harboursideNadia,
    customerId: CUSTOMER.harbourside,
    contact: {
      name: 'Nadia Hassan',
      email: 'nadia.hassan@harbourside-retail.test',
      phone: '+44 117 496 0330',
      jobTitle: 'Site Manager',
      portalRoles: { admin: true },
      isPrimary: true,
      createdAt: days(-120),
    },
  },
  {
    id: CONTACT.harboursideTom,
    customerId: CUSTOMER.harbourside,
    contact: {
      name: 'Tom Fielding',
      email: 'tom.fielding@harbourside-retail.test',
      phone: '+44 117 496 0331',
      jobTitle: 'Health & Safety Officer',
      createdAt: days(-110),
    },
  },
];

// --- Customer members (the customer organisation's accounts) ------------------
// The individual accounts that belong to a customer organisation - the person we
// invite into their space plus the teammates they invite. These are the people an
// assessor can select as the responsible party (name/jobTitle/email/phone auto-
// fill from the account). Stored at /customerMembers/{org}/{customer}/{uid}. Each
// customer's headline contact appears here as the `admin` account.
export interface SeedCustomerMember {
  customerId: string;
  uid: string;
  member: CustomerMember;
}

export const SEED_CUSTOMER_MEMBERS: SeedCustomerMember[] = [
  {
    customerId: CUSTOMER.meridian,
    uid: 'custmbr-meridian-helen-carter',
    member: {
      roles: { admin: true },
      name: 'Helen Carter',
      email: 'helen.carter@meridian-estates.test',
      status: 'active',
      jobTitle: 'Facilities Director',
      phone: '+44 161 496 0110',
    },
  },
  {
    customerId: CUSTOMER.meridian,
    uid: 'custmbr-meridian-marcus-webb',
    member: {
      roles: { viewer: true },
      name: 'Marcus Webb',
      email: 'marcus.webb@meridian-estates.test',
      status: 'active',
      jobTitle: 'Building Manager',
      phone: '+44 161 496 0111',
    },
  },
  {
    customerId: CUSTOMER.northgate,
    uid: 'custmbr-northgate-raymond-ellis',
    member: {
      roles: { admin: true },
      name: 'Raymond Ellis',
      email: 'raymond.ellis@northgate-care.test',
      status: 'active',
      jobTitle: 'Compliance Manager',
      phone: '+44 113 496 0220',
    },
  },
  {
    customerId: CUSTOMER.northgate,
    uid: 'custmbr-northgate-priya-nair',
    member: {
      roles: { viewer: true },
      name: 'Priya Nair',
      email: 'priya.nair@northgate-care.test',
      status: 'active',
      jobTitle: 'Registered Home Manager',
      phone: '+44 113 496 0221',
    },
  },
  {
    customerId: CUSTOMER.harbourside,
    uid: 'custmbr-harbourside-nadia-hassan',
    member: {
      roles: { admin: true },
      name: 'Nadia Hassan',
      email: 'nadia.hassan@harbourside-retail.test',
      status: 'active',
      jobTitle: 'Site Manager',
      phone: '+44 117 496 0330',
    },
  },
  {
    customerId: CUSTOMER.harbourside,
    uid: 'custmbr-harbourside-tom-fielding',
    member: {
      roles: { viewer: true },
      name: 'Tom Fielding',
      email: 'tom.fielding@harbourside-retail.test',
      status: 'active',
      jobTitle: 'Health & Safety Officer',
      phone: '+44 117 496 0331',
    },
  },
];

// --- Sites -------------------------------------------------------------------
export const SEED_SITES: SeedSite[] = [
  {
    id: SITE.meridianCentral,
    customerId: CUSTOMER.meridian,
    site: {
      name: 'Meridian Central',
      address: 'Deansgate Square, Manchester, M15 4PX',
      geo: { lat: 53.4655, lng: -2.2528 },
      contactId: CONTACT.meridianHelen,
    },
  },
  {
    id: SITE.meridianRiverside,
    customerId: CUSTOMER.meridian,
    site: {
      name: 'Meridian Riverside',
      address: 'Ordsall Lane, Salford, M5 3EN',
      geo: { lat: 53.4738, lng: -2.2725 },
      contactId: CONTACT.meridianMarcus,
    },
  },
  {
    id: SITE.northgateLodge,
    customerId: CUSTOMER.northgate,
    site: {
      name: 'Northgate Lodge',
      address: 'Otley Road, Leeds, LS16 5PR',
      geo: { lat: 53.8478, lng: -1.5894 },
      contactId: CONTACT.northgatePriya,
    },
  },
  {
    id: SITE.harboursideQuay,
    customerId: CUSTOMER.harbourside,
    site: {
      name: 'Harbourside Quay',
      address: 'Canons Road, Bristol, BS1 5UH',
      geo: { lat: 51.4496, lng: -2.5994 },
      contactId: CONTACT.harboursideNadia,
    },
  },
];

// --- Building factory --------------------------------------------------------
// `ragDistribution` holds TRUE finding counts; `riskLevel` is the assessor's
// headline opinion. They are independent on purpose so the gauge can render the
// real proportion alongside the opinion (story 1072 AC3).

interface BuildingSeed {
  id: string;
  siteId: string;
  customerId: string;
  name: string;
  address: string;
  area: number;
  floors: number;
  occupiedFloors: number;
  occupants: number;
  isLandlord: boolean;
  alarmType: string;
  alarmCategory: AlarmCategory;
  /** The building's default responsible party - snapshotted from (and linked
   *  back to, via contactId) one of the customer's contacts. */
  responsibleParty: ResponsibleParty;
  article53Persons: string[];
  riskLevel: Building['riskLevel'];
  /** TRUE finding counts from the last assessment. ABSENT (not zeroed) for a
   *  never-assessed building: per the ragDerivation semantics 'pending' means
   *  there is no distribution at all - a {0,0,0} object would falsely read as
   *  "assessed, nothing found". */
  rag?: { low: number; medium: number; high: number };
  /** Whether this building has been assessed (drives lastAssessedAt). */
  assessedDaysAgo?: number;
}

function buildBuilding(seed: BuildingSeed, photoUrl: string): SeedBuilding {
  const building: Building = {
    name: seed.name,
    customerId: seed.customerId,
    address: seed.address,
    details: {
      area: seed.area,
      floors: seed.floors,
      occupiedFloors: seed.occupiedFloors,
      occupants: seed.occupants,
      isLandlord: seed.isLandlord,
      alarmType: seed.alarmType,
      alarmCategory: seed.alarmCategory,
    },
    responsibleParty: seed.responsibleParty,
    article53Persons: seed.article53Persons,
    photoUrl,
    riskLevel: seed.riskLevel,
    // Omitted entirely (never written as zeros) when the building has not been
    // assessed - see the BuildingSeed.rag doc above.
    ...(seed.rag !== undefined ? { ragDistribution: seed.rag } : {}),
    // Staggered next-due dates so the schedule screen shows overdue, due-soon
    // and comfortably-future items at once.
    serviceSchedule: {
      fireAlarmService: { nextDue: days(45) },
      fireMarshalTraining: { nextDue: days(120) },
      fireSafetyTraining: { nextDue: days(-10) }, // overdue, on purpose
      fireDrill: { nextDue: days(75) },
      pat: { nextDue: days(200) },
      extinguisherMaintenance: { nextDue: days(15) }, // due soon
      fraReview: { nextDue: days(330) },
    },
  };
  if (seed.assessedDaysAgo !== undefined) {
    building.lastAssessedAt = days(-seed.assessedDaysAgo);
  }
  return {
    id: seed.id,
    siteId: seed.siteId,
    customerId: seed.customerId,
    photoKey: `photo-${seed.id}`,
    building,
  };
}

// The raw building specs. The proportional-gauge proof lives here: Tower B and
// the Harbourside unit are overwhelmingly green with only a touch of amber/red.
const BUILDING_SEEDS: BuildingSeed[] = [
  {
    id: BUILDING.meridianTowerA,
    siteId: SITE.meridianCentral,
    customerId: CUSTOMER.meridian,
    name: 'Tower A',
    address: 'Deansgate Square, Manchester, M15 4PX',
    area: 8400,
    floors: 14,
    occupiedFloors: 14,
    occupants: 420,
    isLandlord: true,
    alarmType: 'Addressable analogue',
    alarmCategory: 'L2',
    responsibleParty: {
      name: 'Helen Carter',
      role: 'Facilities Director',
      email: 'helen.carter@meridian-estates.test',
      phone: '+44 161 496 0110',
      contactId: CONTACT.meridianHelen,
    },
    article53Persons: ['Meridian Estates Ltd', 'Skyline Managing Agents LLP'],
    riskLevel: 'high',
    // A genuine mix that leans amber/red - this is the higher-risk building.
    rag: { low: 9, medium: 5, high: 3 },
    assessedDaysAgo: 21,
  },
  {
    id: BUILDING.meridianTowerB,
    siteId: SITE.meridianCentral,
    customerId: CUSTOMER.meridian,
    name: 'Tower B',
    address: 'Deansgate Square, Manchester, M15 4PX',
    area: 8100,
    floors: 13,
    occupiedFloors: 12,
    occupants: 360,
    isLandlord: true,
    alarmType: 'Addressable analogue',
    alarmCategory: 'L2',
    responsibleParty: {
      name: 'Helen Carter',
      role: 'Facilities Director',
      email: 'helen.carter@meridian-estates.test',
      phone: '+44 161 496 0110',
      contactId: CONTACT.meridianHelen,
    },
    article53Persons: ['Meridian Estates Ltd', 'Skyline Managing Agents LLP'],
    riskLevel: 'low',
    // Mostly green with a single red - the explicit "NOT all-red" proof.
    rag: { low: 16, medium: 2, high: 1 },
    assessedDaysAgo: 34,
  },
  {
    id: BUILDING.meridianAnnexe,
    siteId: SITE.meridianCentral,
    customerId: CUSTOMER.meridian,
    name: 'Central Annexe',
    address: 'Deansgate Square, Manchester, M15 4PX',
    area: 1200,
    floors: 2,
    occupiedFloors: 2,
    occupants: 40,
    isLandlord: false,
    alarmType: 'Conventional',
    alarmCategory: 'M',
    responsibleParty: {
      name: 'Helen Carter',
      role: 'Facilities Director',
      email: 'helen.carter@meridian-estates.test',
      phone: '+44 161 496 0110',
      contactId: CONTACT.meridianHelen,
    },
    article53Persons: ['Meridian Estates Ltd'],
    // Never assessed - exercises the pending state. No `rag` at all: the
    // distribution must be ABSENT for a pending building, never zero counts.
    riskLevel: 'pending',
  },
  {
    id: BUILDING.riversideMill,
    siteId: SITE.meridianRiverside,
    customerId: CUSTOMER.meridian,
    name: 'Riverside Mill',
    address: 'Ordsall Lane, Salford, M5 3EN',
    area: 5200,
    floors: 5,
    occupiedFloors: 5,
    occupants: 180,
    isLandlord: true,
    alarmType: 'Addressable analogue',
    alarmCategory: 'L3',
    responsibleParty: {
      name: 'Marcus Webb',
      role: 'Building Manager',
      email: 'marcus.webb@meridian-estates.test',
      phone: '+44 161 496 0111',
      contactId: CONTACT.meridianMarcus,
    },
    article53Persons: ['Meridian Estates Ltd'],
    // Assessment is mid-lifecycle; riskLevel is the in-progress opinion.
    riskLevel: 'medium',
    rag: { low: 7, medium: 4, high: 1 },
    assessedDaysAgo: 4,
  },
  {
    id: BUILDING.northgateLodgeHouse,
    siteId: SITE.northgateLodge,
    customerId: CUSTOMER.northgate,
    name: 'Lodge House',
    address: 'Otley Road, Leeds, LS16 5PR',
    area: 2600,
    floors: 3,
    occupiedFloors: 3,
    occupants: 64,
    isLandlord: false,
    // Care home - sleeping risk drives a high alarm category.
    alarmType: 'Addressable analogue',
    alarmCategory: 'L1',
    responsibleParty: {
      name: 'Raymond Ellis',
      role: 'Compliance Manager',
      email: 'raymond.ellis@northgate-care.test',
      phone: '+44 113 496 0220',
      contactId: CONTACT.northgateRaymond,
    },
    article53Persons: ['Northgate Care Group', 'Otley Road Property Holdings Ltd'],
    riskLevel: 'medium',
    rag: { low: 6, medium: 3, high: 2 },
    assessedDaysAgo: 9,
  },
  {
    id: BUILDING.harboursideUnit,
    siteId: SITE.harboursideQuay,
    customerId: CUSTOMER.harbourside,
    name: 'Unit 7 Retail',
    address: 'Canons Road, Bristol, BS1 5UH',
    area: 900,
    floors: 1,
    occupiedFloors: 1,
    occupants: 30,
    isLandlord: false,
    alarmType: 'Conventional',
    alarmCategory: 'M',
    responsibleParty: {
      name: 'Nadia Hassan',
      role: 'Site Manager',
      email: 'nadia.hassan@harbourside-retail.test',
      phone: '+44 117 496 0330',
      contactId: CONTACT.harboursideNadia,
    },
    article53Persons: ['Harbourside Retail Park'],
    // Scheduled but not yet assessed; low risk and mostly green from a prior
    // light-touch review. Deliberately has NO floor plan (see floorPlans.ts).
    riskLevel: 'low',
    rag: { low: 11, medium: 1, high: 0 },
  },
];

/** Build all buildings, given a map of buildingId -> uploaded photo URL. */
export function buildBuildings(
  photoUrls: Record<string, string>,
): SeedBuilding[] {
  return BUILDING_SEEDS.map((seed) =>
    buildBuilding(seed, photoUrls[seed.id] ?? ''),
  );
}

/** The building photo keys, so the seed knows which photos to generate/upload. */
export const BUILDING_PHOTO_KEYS = BUILDING_SEEDS.map((s) => ({
  buildingId: s.id,
  key: `photo-${s.id}`,
}));
