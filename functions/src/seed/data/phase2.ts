// ============================================================================
// Phase 2 demo data (story 2081) - every Phase 2 web surface has something to
// show the moment the seed has run.
//
// This module adds, on top of the Phase 1 world:
//   - invitations in every non-accepted state (pending staff, pending PORTAL,
//     revoked, expired), each with its admin-facing summary, so the staff
//     directory's invitations panel and the portal-invite flow render real
//     rows (FR-E15 / FR-E22);
//   - a template DRAFT plus a custom template with TWO published versions in
//     /templateVersions, so the builder's draft list and the version-history
//     browser both have content (FR-E21);
//   - Standard Paragraphs referenced from that template's questions (FR-E21);
//   - one extra OVERDUE, non-Life-Protection action, so the overdue filters
//     show a mix (the Phase 1 seed's High/LTP actions are already overdue by
//     the DUE_WINDOW_DAYS maths - see data/actions.ts);
//   - fraReview overrides: one building due for review inside 30 days and one
//     LAPSED, driving the review-reminder surfaces (FR-E20).
//
// The buildingCustomerIndex entries (which the PORTAL rules gate every
// per-building read on) and the portal-ready customer account are built in
// seed/index.ts because they derive from the building/member data there.
//
// Same discipline as every other seed module: fixed ids, set() writes,
// idempotent re-runs. The one exception is the invitation TOKEN, which is
// random per run (a bearer secret must never be a guessable constant); set()
// overwrites the whole invitation node, so idempotency is preserved.
// ============================================================================

import { randomUUID } from 'node:crypto';
import type {
  Action,
  Invitation,
  InvitationSummary,
  StandardParagraph,
  Template,
} from '../../shared/types';
import {
  ORG_ID,
  UID,
  CUSTOMER,
  SITE,
  CONTACT,
  BUILDING,
  ASSESSMENT,
  days,
} from '../ids';

// --- Invitations (FR-E15 staff + FR-E22 portal) -------------------------------

const INVITE = {
  pendingStaff: 'invite-pending-auditor',
  pendingPortal: 'invite-pending-portal-marcus',
  revoked: 'invite-revoked-assessor',
  expired: 'invite-expired-finance',
} as const;

export interface SeedInvitation {
  id: string;
  invitation: Invitation;
  summary: InvitationSummary;
}

/** Build the invitation set. Tokens are minted per run (never guessable). */
export function buildInvitations(): SeedInvitation[] {
  const make = (
    id: string,
    fields: Omit<Invitation, 'orgId' | 'token'>,
    createdAt: number,
  ): SeedInvitation => ({
    id,
    invitation: { orgId: ORG_ID, token: randomUUID(), ...fields },
    summary: {
      email: fields.email,
      roles: fields.roles,
      ...(fields.customerId !== undefined ? { customerId: fields.customerId } : {}),
      ...(fields.contactId !== undefined ? { contactId: fields.contactId } : {}),
      status: fields.status,
      expiresAt: fields.expiresAt,
      createdAt,
      invitedBy: UID.admin,
    },
  });

  return [
    // A live, acceptable staff invitation (the pending row in the directory).
    make(
      INVITE.pendingStaff,
      {
        email: 'imogen.auditor@firerite-demo.test',
        roles: { auditor: true },
        expiresAt: days(6),
        status: 'pending',
      },
      days(-1),
    ),
    // A live PORTAL invitation for a customer contact who has not accepted yet
    // (Marcus Webb at Meridian): the customer-invite flow end to end.
    make(
      INVITE.pendingPortal,
      {
        email: 'marcus.webb@meridian-estates.test',
        roles: { viewer: true },
        customerId: CUSTOMER.meridian,
        contactId: CONTACT.meridianMarcus,
        expiresAt: days(6),
        status: 'pending',
      },
      days(-1),
    ),
    // Revoked by the admin before acceptance.
    make(
      INVITE.revoked,
      {
        email: 'former.contractor@firerite-demo.test',
        roles: { assessor: true },
        expiresAt: days(3),
        status: 'revoked',
      },
      days(-4),
    ),
    // Ran out of time (expiresAt in the past, status stamped by the sweep).
    make(
      INVITE.expired,
      {
        email: 'never.joined@firerite-demo.test',
        roles: { finance: true },
        expiresAt: days(-2),
        status: 'expired',
      },
      days(-9),
    ),
  ];
}

// --- Standard Paragraphs (FR-E21) ---------------------------------------------

const PARAGRAPH = {
  meansOfEscape: 'sp-means-of-escape',
  fireDoors: 'sp-fire-doors',
} as const;

export const SEED_STANDARD_PARAGRAPHS: Array<{
  id: string;
  paragraph: StandardParagraph;
}> = [
  {
    id: PARAGRAPH.meansOfEscape,
    paragraph: {
      reference: '4.2.1',
      title: 'Means of escape - travel distances',
      body:
        'Escape routes should provide, from every occupiable point, travel distances within the limits appropriate to the risk profile of the premises, leading to a place of ultimate safety. Where a single direction of travel is unavoidable, the distance should be minimised and the route protected.',
      updatedAt: days(-30),
    },
  },
  {
    id: PARAGRAPH.fireDoors,
    paragraph: {
      reference: '5.1.3',
      title: 'Fire doors - condition and self-closing',
      body:
        'Fire-resisting doors should be maintained so that intumescent strips and cold smoke seals are continuous and undamaged, self-closing devices close the leaf fully into the frame from any angle, and doors are never held open other than by an approved automatic release.',
      updatedAt: days(-30),
    },
  },
];

// --- Templates: a draft + a twice-published custom template (FR-E21) ----------

export const DRAFT_TEMPLATE_ID = 'tmpl-draft-hmo-audit';
export const VERSIONED_TEMPLATE_ID = 'tmpl-warehouse-custom';

/** An in-progress draft: visible in the builder's draft list, publishable. */
export const DRAFT_TEMPLATE: Template = {
  name: 'HMO Common Parts Audit (draft)',
  version: 0,
  status: 'draft',
  standard: 'custom',
  sections: [
    {
      id: 'sec-hmo-01',
      code: '01',
      title: 'General Information',
      questions: [
        {
          id: 'q-hmo-01-01',
          text: 'Number of self-contained units served by the common parts?',
          type: 'text',
          required: true,
        },
      ],
    },
    {
      id: 'sec-hmo-02',
      code: '02',
      title: 'Common Escape Routes',
      questions: [
        {
          id: 'q-hmo-02-01',
          text: 'Are the common escape routes free of combustible storage?',
          type: 'yesno',
          required: true,
          allowsPhotos: true,
          standardParagraphRef: PARAGRAPH.meansOfEscape,
        },
      ],
    },
  ],
};

/** Version 1 of the custom template, as it was first published. */
const VERSIONED_TEMPLATE_V1: Template = {
  name: 'Warehouse Fire Safety Inspection',
  version: 1,
  status: 'published',
  publishedAt: days(-60),
  standard: 'custom',
  sections: [
    {
      id: 'sec-wh-01',
      code: '01',
      title: 'Storage and Housekeeping',
      questions: [
        {
          id: 'q-wh-01-01',
          text: 'Is racked storage clear of luminaires and sprinkler heads?',
          type: 'yesno',
          required: true,
          allowsPhotos: true,
        },
      ],
    },
    {
      id: 'sec-wh-02',
      code: '02',
      title: 'Escape and Exits',
      questions: [
        {
          id: 'q-wh-02-01',
          text: 'Are designated exits unobstructed and openable without a key?',
          type: 'yesno',
          required: true,
          standardParagraphRef: PARAGRAPH.meansOfEscape,
        },
      ],
    },
  ],
};

/** Version 2: a section and a question added, showing genuine history. */
const VERSIONED_TEMPLATE_V2: Template = {
  ...VERSIONED_TEMPLATE_V1,
  version: 2,
  publishedAt: days(-20),
  sections: [
    ...VERSIONED_TEMPLATE_V1.sections,
    {
      id: 'sec-wh-03',
      code: '03',
      title: 'Fire Doors',
      questions: [
        {
          id: 'q-wh-03-01',
          text: 'Do fire doors to the warehouse floor close fully from any angle?',
          type: 'nonConformity',
          required: false,
          allowsPhotos: true,
          allowsFlagLocation: true,
          standardParagraphRef: PARAGRAPH.fireDoors,
        },
      ],
    },
  ],
};

/** The live node is the LATEST published version; the archive holds both. */
export const VERSIONED_TEMPLATE_LIVE: Template = VERSIONED_TEMPLATE_V2;
export const VERSIONED_TEMPLATE_ARCHIVE: Array<{
  version: number;
  template: Template;
}> = [
  { version: 1, template: VERSIONED_TEMPLATE_V1 },
  { version: 2, template: VERSIONED_TEMPLATE_V2 },
];

// --- An extra overdue (non-Life-Protection) action (FR-E20) -------------------
// The Phase 1 actions already include OVERDUE + Life Protection High findings
// (dueBy = severity window minus 18 days, so every H action is 11 days past
// due). This adds a MEDIUM overdue action so overdue surfacing shows a mix of
// severities and LTP states.

export const OVERDUE_ACTION_ID = 'act-tower-b-signage-overdue';
export const OVERDUE_ACTION: { buildingId: string; action: Action } = {
  buildingId: BUILDING.meridianTowerB,
  action: {
    assessmentId: ASSESSMENT.towerB,
    sectionCode: '06',
    question: 'Is escape signage adequate and correctly directional?',
    observation:
      'Replace the missing directional escape sign at the head of the east stair, Level 2. The route is currently unsigned at a change of direction.',
    severity: 'M',
    // Linked, like every other seeded action: an overdue action that names
    // nobody the platform can email would demonstrate the deadline sweep
    // skipping rather than chasing.
    responsible: 'Helen Carter',
    responsibleContactId: CONTACT.meridianHelen,
    dueBy: days(-5),
    lifeProtection: false,
    status: 'open',
  },
};

// --- fraReview overrides (FR-E20 review tracking) ------------------------------
// The base buildings all carry a comfortably-future fraReview (about 11 months
// out). These two overrides create the states the review tracker must surface:
// due WITHIN 30 days, and LAPSED.

export const FRA_REVIEW_OVERRIDES: Array<{
  buildingId: string;
  siteId: string;
  nextDue: number;
}> = [
  // Due soon: inside the 30-day reminder window.
  { buildingId: BUILDING.meridianTowerB, siteId: SITE.meridianCentral, nextDue: days(30) },
  // Lapsed: the review date has passed with no new FRA released.
  { buildingId: BUILDING.northgateLodgeHouse, siteId: SITE.northgateLodge, nextDue: days(-14) },
];
