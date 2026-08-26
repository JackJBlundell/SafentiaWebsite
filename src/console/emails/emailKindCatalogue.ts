// ============================================================================
// emailKindCatalogue - the catalogue of every outgoing email kind (section 6b).
//
// One definition per EmailKindId: its audience, its EmailLogEntry category,
// whether an org may toggle it off, the {{variables}} its send site supplies,
// and - most importantly - its DEFAULT TEMPLATE, which is today's hardcoded
// copy extracted VERBATIM from the send site into the block vocabulary. The
// refactor that moves each send site onto the templating seam must change
// nothing user-visible, so nothing in this file invents, improves or rephrases
// a single sentence: every subject, heading, paragraph, row and footer below
// is a faithful transcription of the send site named beside it, with the
// interpolated values replaced by {{dotted.variables}} declared alongside.
//
// Pure by design: no imports beyond the mirrored types contract and the
// sibling variable engine, no I/O, so the console settings pages and the
// Cloud Functions send path share this exact implementation byte-for-byte
// (the ragDerivation/emailVariableEngine mirroring pattern).
// ============================================================================

import type {
  EmailDeliveryPolicy,
  EmailKindId,
  EmailTemplateBlock,
} from '../../types';
import type { EmailTemplateShape } from './emailVariableEngine';

/** One variable a kind's send site supplies to the template renderer. The
 *  label and example exist for the console's template editor: the label names
 *  the value in plain English, and the example is what the live preview
 *  substitutes. */
export interface EmailVariableSpec {
  name: string;
  label: string;
  example: string;
}

/** The bundled form of a kind: the copy used when two or more of its sends
 *  collapse into one daily email. */
export interface EmailKindDigest {
  /** Singular / plural noun for the count phrase: ['building', 'buildings']. */
  noun: [string, string];
  /** Console/portal path for the digest's CTA - a digest cannot deep-link one
   *  item. The flush prefixes WEB_ORIGIN; the catalogue is a pure mirrored
   *  module and must not import it. */
  ctaPath: string;
  /** The bundled copy, in the same block vocabulary as defaultTemplate. */
  defaultTemplate: EmailTemplateShape;
}

export interface EmailKindDefinition {
  id: EmailKindId;
  /** Short UI label, e.g. 'Review reminder (admins)'. */
  label: string;
  /** One calm sentence for the settings page. */
  description: string;
  /** The EXISTING EmailLogEntry.category string this kind's sends have always
   *  logged under, preserved exactly so the log's filters keep working. */
  category: string;
  audience: 'org-member' | 'customer-contact' | 'invitee' | 'manual';
  /** False only for 'invitation' (a security email an org may never silence)
   *  and 'manual' (an admin-composed send has no toggle to speak of). */
  toggleAllowed: boolean;
  /** Every {{variable}} the kind's send site supplies, with realistic
   *  examples for the editor's live preview. */
  variables: EmailVariableSpec[];
  /** The send site supplies a canonical per-recipient CTA URL, consumed by a
   *  cta block's `useKindLink`. */
  hasKindLink: boolean;
  /** The send site supplies dynamic detail rows (digest lists, visit cards,
   *  rows whose presence is conditional), consumed by a detail-rows block
   *  with source 'kind'. */
  hasKindRows: boolean;
  /** Today's copy, verbatim, as blocks. */
  defaultTemplate: EmailTemplateShape;
  /** How this kind reaches its recipient (see EmailDeliveryPolicy). */
  delivery: EmailDeliveryPolicy;
  /** Present only on kinds that may be bundled. Absent = never bundled. */
  digest?: EmailKindDigest;
}

// ----------------------------------------------------------------------------
// Footer lines shared verbatim by several send sites, written once so the
// transcriptions cannot drift apart.
// ----------------------------------------------------------------------------

/** lib/jobEmails.ts JOB_EMAIL_FOOTER - every diary email's shared line. */
const JOB_FOOTER =
  'You are receiving this because these visits are in your Safentia diary. You can turn job emails off in your account settings.';

/** The assessor-facing footer shared by deadlineReminders (information
 *  requests), requestInfo and onAssessmentStageChange (assessor outcome). */
const ASSESSOR_FOOTER =
  'You are receiving this because you are the assessor on this job. You can turn these emails off in your Safentia account settings.';

/** The org-admin footer shared by reviewReminders, deadlineReminders (digest),
 *  manageCustomerContact and customerContracts. */
const ORG_ADMIN_FOOTER =
  'You are receiving this because you are an administrator of {{org.name}} on Safentia.';

/** lib/jobEmails.ts sendVisitCustomerEmails - the visit emails' shared
 *  customer footer. */
const VISIT_FOOTER =
  'You are receiving this because you are listed as a contact for {{building.name}} on Safentia. This is a service message about a visit to your building.';

// ----------------------------------------------------------------------------
// Footers for the bundled form. A digest spans several buildings and several
// actions, and its variable vocabulary carries no {{building.name}}, so the
// three building-scoped footers above cannot be reused verbatim: each is the
// same sentence, generalised to the list the recipient is holding. The footers
// with no building in them (JOB_FOOTER, ASSESSOR_FOOTER, ORG_ADMIN_FOOTER) are
// reused as they stand.
// ----------------------------------------------------------------------------

/** The digest form of VISIT_FOOTER. */
const VISIT_DIGEST_FOOTER =
  'You are receiving this because you are listed as a contact for these buildings on Safentia. This is a service message about visits to them.';

/** The digest form of the customer-contact footer used by the review reminder
 *  and released-report emails. */
const CONTACT_DIGEST_FOOTER =
  'You are receiving this because you are a contact for these buildings on Safentia.';

/** The digest form of the footer shared by the action emails. */
const RESPONSIBLE_DIGEST_FOOTER =
  'You are receiving this because you are recorded as responsible for these actions on Safentia.';

// ----------------------------------------------------------------------------
// Variable specs shared by several kinds.
// ----------------------------------------------------------------------------

const ORG_NAME: EmailVariableSpec = {
  name: 'org.name',
  label: 'Organisation name',
  example: 'Acme Fire Safety Ltd',
};

const BUILDING_NAME: EmailVariableSpec = {
  name: 'building.name',
  label: 'Building name',
  example: 'Rose Court',
};

/** A detail-rows block fed by the send site, for the kinds whose rows are a
 *  dynamic list or carry conditional entries. */
const KIND_ROWS: EmailTemplateBlock = {
  id: 'rows',
  type: 'detail-rows',
  source: 'kind',
};

export const EMAIL_KINDS: Record<EmailKindId, EmailKindDefinition> = {
  // --------------------------------------------------------------------------
  // Source: lib/invitations.ts issueInvitation. The kind link is the web
  // acceptance URL (/invite?token=...). NOTE: functions/resendInvitation.ts
  // currently sends a slightly different, app-first wording for the same
  // event; the catalogue default is the issueInvitation copy, and the later
  // refactor unifies the resend path onto this default.
  // --------------------------------------------------------------------------
  invitation: {
    id: 'invitation',
    label: 'Invitation',
    description:
      'Sent to an email address an administrator invites to join the organisation, carrying the personal accept link.',
    category: 'invitation',
    audience: 'invitee',
    toggleAllowed: false,
    variables: [
      ORG_NAME,
      {
        name: 'recipient.email',
        label: 'Invited email address',
        example: 'jordan@example.com',
      },
      {
        name: 'invite.url',
        label: 'Web accept link',
        example: 'https://safentia.co.uk/invite?token=abc123',
      },
      {
        name: 'invite.expiry',
        label: 'Invitation expiry date',
        example: '13 August 2026',
      },
      {
        name: 'invite.appUrl',
        label: 'App accept link',
        example: 'safentia://invite?token=abc123&env=live',
      },
    ],
    hasKindLink: true,
    hasKindRows: false,
    defaultTemplate: {
      subject: 'You have been invited to Safentia',
      preheader:
        'Accept your invitation to join your organisation on Safentia.',
      heading: 'You have been invited to Safentia',
      blocks: [
        {
          id: 'p1',
          type: 'paragraph',
          text: 'Your organisation has invited you to join it on Safentia, the fire risk assessment platform.',
        },
        {
          id: 'p2',
          type: 'paragraph',
          text: 'The button below opens a page where you choose a password and your account is set up in under a minute.',
        },
        {
          id: 'p3',
          type: 'paragraph',
          text: 'The invitation is personal to you, works once, and expires after seven days.',
        },
        {
          id: 'p4',
          type: 'paragraph',
          text: 'On your phone with the Safentia app installed? Use the app link instead: {{invite.appUrl}}',
        },
        { id: 'cta', type: 'cta', label: 'Accept your invitation', useKindLink: true },
      ],
      footerNote:
        'You are receiving this because an administrator at your organisation invited this email address to Safentia. If you were not expecting it, you can safely ignore this email.',
    },
    // Immediate: a security email an org may never hold back.
    delivery: 'immediate',
  },

  // --------------------------------------------------------------------------
  // Source: functions/reviewReminders.ts, the admin notice. The subject and
  // the body's closing phrase vary between overdue and due-in-N-days, so the
  // send site supplies the exact phrases it computes today.
  // --------------------------------------------------------------------------
  'review-reminder-admin': {
    id: 'review-reminder-admin',
    label: 'Review reminder (admins)',
    description:
      'Reminds administrators that a building’s fire risk assessment review is approaching or overdue.',
    category: 'review-reminder',
    audience: 'org-member',
    toggleAllowed: true,
    variables: [
      ORG_NAME,
      BUILDING_NAME,
      {
        name: 'review.subjectPhrase',
        label: 'Subject phrase: ‘FRA review overdue’ or ‘FRA review due in N days’, exactly as computed today',
        example: 'FRA review due in 60 days',
      },
      {
        name: 'review.stagePhrase',
        label: 'Body phrase: ‘now overdue’ or ‘due in N days’, exactly as computed today',
        example: 'due in 60 days',
      },
      {
        name: 'review.dueDate',
        label: 'Review due date',
        example: '5 October 2026',
      },
      {
        name: 'review.daysRemaining',
        label: 'Days remaining row: ‘Overdue’ or ‘N days’',
        example: '60 days',
      },
    ],
    hasKindLink: true,
    hasKindRows: false,
    defaultTemplate: {
      subject: '{{review.subjectPhrase}}: {{building.name}}',
      preheader:
        'The fire risk assessment review for {{building.name}} is {{review.stagePhrase}}.',
      heading: '{{org.name}}: fire risk assessment review',
      blocks: [
        {
          id: 'p1',
          type: 'paragraph',
          text: 'The fire risk assessment review for {{building.name}} is {{review.stagePhrase}}.',
        },
        {
          id: 'p2',
          type: 'paragraph',
          text: 'Reviews keep the assessment current; please arrange the review before the due date passes.',
        },
        {
          id: 'rows',
          type: 'detail-rows',
          source: 'custom',
          rows: [
            { id: 'building', label: 'Building', value: '{{building.name}}' },
            { id: 'due', label: 'Review due', value: '{{review.dueDate}}' },
            {
              id: 'remaining',
              label: 'Days remaining',
              value: '{{review.daysRemaining}}',
            },
          ],
        },
        { id: 'cta', type: 'cta', label: 'View the building', useKindLink: true },
      ],
      footerNote: ORG_ADMIN_FOOTER,
    },
    // Digest: a daily sweep by nature, and its cron runs before the flush.
    delivery: 'digest',
    digest: {
      noun: ['building', 'buildings'],
      ctaPath: '/app/customers',
      defaultTemplate: {
        subject: '{{digest.countPhrase}} need a fire risk assessment review',
        preheader:
          '{{digest.countPhrase}} in your estate have a review approaching or overdue.',
        heading: '{{org.name}}: fire risk assessment reviews',
        blocks: [
          {
            id: 'p1',
            type: 'paragraph',
            text: '{{digest.countPhrase}} in your estate have a fire risk assessment review approaching or overdue.',
          },
          {
            id: 'p2',
            type: 'paragraph',
            text: 'Reviews keep each assessment current; please arrange them before the due dates pass.',
          },
          KIND_ROWS,
          { id: 'more', type: 'paragraph', text: '{{digest.moreNote}}', omitIfEmpty: true },
          { id: 'cta', type: 'cta', label: 'View your customers', useKindLink: true },
        ],
        footerNote: ORG_ADMIN_FOOTER,
      },
    },
  },

  // --------------------------------------------------------------------------
  // Source: functions/reviewReminders.ts, the customer notice. The heading and
  // the whole body sentence differ structurally between overdue and due-in-N-
  // days (the due version reassures, the overdue version asks the contact to
  // ring their provider), so the send site supplies both exactly as computed.
  // --------------------------------------------------------------------------
  'review-reminder-contact': {
    id: 'review-reminder-contact',
    label: 'Review reminder (customer contacts)',
    description:
      'Tells a building’s customer contacts that its fire risk assessment review is approaching or overdue.',
    category: 'review-reminder',
    audience: 'customer-contact',
    toggleAllowed: true,
    variables: [
      BUILDING_NAME,
      {
        name: 'review.subjectPhrase',
        label: 'Subject phrase: ‘FRA review overdue’ or ‘FRA review due in N days’, exactly as computed today',
        example: 'FRA review due in 30 days',
      },
      {
        name: 'review.headingPhrase',
        label: 'Heading: ‘Fire risk assessment review overdue’ or ‘Fire risk assessment review due’',
        example: 'Fire risk assessment review due',
      },
      {
        name: 'review.bodyText',
        label: 'Body sentences, exactly as computed today for the overdue or due-in-N-days case',
        example:
          'The fire risk assessment review for Rose Court is due in 30 days. Acme Fire Safety Ltd arranges this; there is nothing you need to do unless they ask you to.',
      },
      {
        name: 'review.dueDate',
        label: 'Review due date',
        example: '5 September 2026',
      },
    ],
    hasKindLink: true,
    hasKindRows: false,
    defaultTemplate: {
      subject: '{{review.subjectPhrase}}: {{building.name}}',
      preheader: '{{review.bodyText}}',
      heading: '{{review.headingPhrase}}',
      blocks: [
        { id: 'p1', type: 'paragraph', text: '{{review.bodyText}}' },
        {
          id: 'rows',
          type: 'detail-rows',
          source: 'custom',
          rows: [
            { id: 'building', label: 'Building', value: '{{building.name}}' },
            { id: 'due', label: 'Review due', value: '{{review.dueDate}}' },
          ],
        },
        { id: 'cta', type: 'cta', label: 'View your building', useKindLink: true },
      ],
      footerNote:
        'You are receiving this because you are a contact for {{building.name}} on Safentia.',
    },
    // Digest: the same sweep, seen from the customer’s side.
    delivery: 'digest',
    digest: {
      noun: ['building', 'buildings'],
      ctaPath: '/app',
      defaultTemplate: {
        subject: 'Fire risk assessment reviews: {{digest.countPhrase}}',
        preheader:
          '{{digest.countPhrase}} you are a contact for have a review approaching or overdue.',
        heading: 'Fire risk assessment reviews',
        blocks: [
          {
            id: 'p1',
            type: 'paragraph',
            text: '{{digest.countPhrase}} you are a contact for have a fire risk assessment review approaching or overdue.',
          },
          {
            id: 'p2',
            type: 'paragraph',
            text: 'Your provider arranges these reviews; there is nothing you need to do unless they ask you to.',
          },
          KIND_ROWS,
          { id: 'more', type: 'paragraph', text: '{{digest.moreNote}}', omitIfEmpty: true },
          { id: 'cta', type: 'cta', label: 'View your buildings', useKindLink: true },
        ],
        footerNote: CONTACT_DIGEST_FOOTER,
      },
    },
  },

  // --------------------------------------------------------------------------
  // Source: functions/deadlineReminders.ts, part 1 (open information requests,
  // chasing the assessor). The subject's closing phrase is 'overdue' when
  // lapsed and stagePhrase ('due tomorrow' / 'due in N days') otherwise; the
  // body always uses stagePhrase ('now overdue' when lapsed).
  // --------------------------------------------------------------------------
  'deadline-info-assessor': {
    id: 'deadline-info-assessor',
    label: 'Information request deadline (assessors)',
    description:
      'Chases the assessor when their response to an auditor’s information request is approaching its deadline or overdue.',
    category: 'deadline-reminder',
    audience: 'org-member',
    toggleAllowed: true,
    variables: [
      {
        name: 'info.subjectStagePhrase',
        label: 'Subject phrase: ‘overdue’ when lapsed, else ‘due tomorrow’ / ‘due in N days’',
        example: 'due in 3 days',
      },
      {
        name: 'info.stagePhrase',
        label: 'Body phrase: ‘now overdue’, ‘due tomorrow’ or ‘due in N days’',
        example: 'due in 3 days',
      },
      {
        name: 'info.questionsPhrase',
        label: 'Question count phrase, e.g. ‘1 question’ or ‘3 questions’',
        example: '3 questions',
      },
      {
        name: 'info.dueDate',
        label: 'Response due date',
        example: '14 August 2026',
      },
      {
        name: 'info.statusLabel',
        label: 'Status row: ‘Overdue’ when lapsed, else the stage phrase',
        example: 'due in 3 days',
      },
    ],
    hasKindLink: true,
    hasKindRows: false,
    defaultTemplate: {
      subject: 'An information request is {{info.subjectStagePhrase}}',
      preheader:
        'Your response to {{info.questionsPhrase}} on a fire risk assessment is {{info.stagePhrase}}.',
      heading: 'Information still required',
      blocks: [
        {
          id: 'p1',
          type: 'paragraph',
          text: 'Your response to {{info.questionsPhrase}} on a fire risk assessment is {{info.stagePhrase}}.',
        },
        {
          id: 'p2',
          type: 'paragraph',
          text: 'Open the job, answer each flagged question and resubmit the assessment. It returns to the validation queue once you do.',
        },
        {
          id: 'rows',
          type: 'detail-rows',
          source: 'custom',
          rows: [
            {
              id: 'outstanding',
              label: 'Questions outstanding',
              value: '{{info.questionsPhrase}}',
            },
            { id: 'due', label: 'Response due by', value: '{{info.dueDate}}' },
            { id: 'status', label: 'Status', value: '{{info.statusLabel}}' },
          ],
        },
        { id: 'cta', type: 'cta', label: 'Open the job', useKindLink: true },
      ],
      footerNote: ASSESSOR_FOOTER,
    },
    // Digest: the deadline sweep, which runs before the flush.
    delivery: 'digest',
    digest: {
      noun: ['assessment', 'assessments'],
      ctaPath: '/app/jobs',
      defaultTemplate: {
        subject: 'Information still required on {{digest.countPhrase}}',
        preheader:
          'Your response is approaching its deadline or overdue on {{digest.countPhrase}}.',
        heading: 'Information still required',
        blocks: [
          {
            id: 'p1',
            type: 'paragraph',
            text: 'Your response to an auditor’s information request is approaching its deadline or overdue on {{digest.countPhrase}}.',
          },
          {
            id: 'p2',
            type: 'paragraph',
            text: 'Open each job, answer the flagged questions and resubmit. An assessment returns to the validation queue once you do.',
          },
          KIND_ROWS,
          { id: 'more', type: 'paragraph', text: '{{digest.moreNote}}', omitIfEmpty: true },
          { id: 'cta', type: 'cta', label: 'Open your jobs', useKindLink: true },
        ],
        footerNote: ASSESSOR_FOOTER,
      },
    },
  },

  // --------------------------------------------------------------------------
  // Source: functions/deadlineReminders.ts, part 2 (open actions, chasing the
  // responsible contact). The detail card carries conditional rows
  // (Responsible, Life protection) beside the fixed four, so the send site
  // supplies the rows it builds today.
  // --------------------------------------------------------------------------
  'deadline-action-contact': {
    id: 'deadline-action-contact',
    label: 'Action deadline (responsible contacts)',
    description:
      'Chases the customer contact responsible for a fire-safety action as its due date approaches or passes.',
    category: 'deadline-reminder',
    audience: 'customer-contact',
    toggleAllowed: true,
    variables: [
      BUILDING_NAME,
      {
        name: 'action.subjectStagePhrase',
        label: 'Subject phrase: ‘overdue’ when lapsed, else ‘due tomorrow’ / ‘due in N days’',
        example: 'due in 3 days',
      },
      {
        name: 'action.stagePhrase',
        label: 'Body phrase: ‘now overdue’, ‘due tomorrow’ or ‘due in N days’',
        example: 'due in 3 days',
      },
      {
        name: 'action.severityLower',
        label: 'Severity, lower-case, e.g. ‘high’',
        example: 'high',
      },
    ],
    hasKindLink: true,
    hasKindRows: true,
    defaultTemplate: {
      subject:
        'An action assigned to you is {{action.subjectStagePhrase}}: {{building.name}}',
      preheader:
        'A {{action.severityLower}} fire-safety action at {{building.name}} is {{action.stagePhrase}}.',
      heading: 'A fire-safety action needs your attention',
      blocks: [
        {
          id: 'p1',
          type: 'paragraph',
          text: 'A {{action.severityLower}} fire-safety action at {{building.name}} is {{action.stagePhrase}}.',
        },
        {
          id: 'p2',
          type: 'paragraph',
          text: 'Please arrange the remedial work. Your provider signs the action off once it is complete.',
        },
        KIND_ROWS,
        { id: 'cta', type: 'cta', label: 'View your building', useKindLink: true },
      ],
      footerNote:
        'You are receiving this because you are recorded as responsible for this action at {{building.name}} on Safentia.',
    },
    // Digest: the same sweep, chasing the responsible contact.
    delivery: 'digest',
    digest: {
      noun: ['action', 'actions'],
      ctaPath: '/app',
      defaultTemplate: {
        subject: '{{digest.countPhrase}} assigned to you need attention',
        preheader:
          '{{digest.countPhrase}} assigned to you are approaching their due dates or overdue.',
        heading: 'Fire-safety actions need your attention',
        blocks: [
          {
            id: 'p1',
            type: 'paragraph',
            text: 'You have {{digest.countPhrase}} approaching their due dates or already overdue.',
          },
          {
            id: 'p2',
            type: 'paragraph',
            text: 'Please arrange the remedial work. Your provider signs each action off once it is complete.',
          },
          KIND_ROWS,
          { id: 'more', type: 'paragraph', text: '{{digest.moreNote}}', omitIfEmpty: true },
          { id: 'cta', type: 'cta', label: 'View your action plans', useKindLink: true },
        ],
        footerNote: RESPONSIBLE_DIGEST_FOOTER,
      },
    },
  },

  // --------------------------------------------------------------------------
  // Source: functions/deadlineReminders.ts, the per-org admin digest. The
  // subject and summary sentence differ structurally between the one-action
  // and many-actions cases, and the CTA's label switches with them ('View the
  // action plan' / 'View your customers'), so the send site supplies all
  // three exactly as computed today. The rows are the digest list itself.
  // --------------------------------------------------------------------------
  'deadline-admin-digest': {
    id: 'deadline-admin-digest',
    label: 'Action deadline digest (admins)',
    description:
      'A single daily notice to administrators listing every fire-safety action that is approaching its deadline or overdue.',
    category: 'deadline-reminder',
    audience: 'org-member',
    toggleAllowed: true,
    variables: [
      ORG_NAME,
      {
        name: 'digest.subjectText',
        label: 'Full subject, exactly as computed today for the one-action or many-actions case',
        example: '3 fire-safety actions need attention',
      },
      {
        name: 'digest.summaryText',
        label: 'Summary sentence, exactly as computed today',
        example:
          '3 fire-safety actions on your action plans need attention, 1 of them overdue.',
      },
      {
        name: 'digest.ctaLabel',
        label: 'CTA label: ‘View the action plan’ for one action, ‘View your customers’ for several',
        example: 'View your customers',
      },
    ],
    hasKindLink: true,
    hasKindRows: true,
    defaultTemplate: {
      subject: '{{digest.subjectText}}',
      preheader: '{{digest.summaryText}}',
      heading: '{{org.name}}: action plan',
      blocks: [
        { id: 'p1', type: 'paragraph', text: '{{digest.summaryText}}' },
        {
          id: 'p2',
          type: 'paragraph',
          text: 'Please check the remedial work is arranged, and sign each action off once it is complete.',
        },
        KIND_ROWS,
        { id: 'cta', type: 'cta', label: '{{digest.ctaLabel}}', useKindLink: true },
      ],
      footerNote: ORG_ADMIN_FOOTER,
    },
    // Immediate: already one email per admin per day by construction.
    delivery: 'immediate',
  },

  // --------------------------------------------------------------------------
  // Source: functions/dailyJobReminders.ts, the 07:00 diary digest. The rows
  // are the day's visits in running order.
  // --------------------------------------------------------------------------
  'job-reminder': {
    id: 'job-reminder',
    label: 'Daily job digest (assessors)',
    description:
      'The 07:00 email listing everything in an assessor’s diary for the day ahead.',
    category: 'job-reminder',
    audience: 'org-member',
    toggleAllowed: true,
    variables: [
      {
        name: 'jobs.visitCountPhrase',
        label: 'Visit count phrase for the subject, e.g. ‘1 visit’ or ‘3 visits’',
        example: '3 visits',
      },
      {
        name: 'jobs.countPhrase',
        label: 'Job count phrase for the lead sentence, e.g. ‘1 job’ or ‘3 jobs’',
        example: '3 jobs',
      },
    ],
    hasKindLink: true,
    hasKindRows: true,
    defaultTemplate: {
      subject: 'Your jobs today: {{jobs.visitCountPhrase}}',
      preheader: 'You have {{jobs.countPhrase}} scheduled today.',
      heading: 'Your jobs today',
      blocks: [
        {
          id: 'p1',
          type: 'paragraph',
          text: 'You have {{jobs.countPhrase}} scheduled today.',
        },
        {
          id: 'p2',
          type: 'paragraph',
          text: 'This is your diary as it stood at 07:00. Anything booked, moved or cancelled after that is sent to you on its own.',
        },
        KIND_ROWS,
        { id: 'cta', type: 'cta', label: 'Open your jobs', useKindLink: true },
      ],
      footerNote: JOB_FOOTER,
    },
    // Immediate: already one email per assessor per day by construction.
    delivery: 'immediate',
  },

  // --------------------------------------------------------------------------
  // Source: lib/jobEmails.ts sendJobChangeEmail, called from
  // functions/createJob.ts. The subject and heading vary between today and a
  // future date ('New job today' / 'New job assigned'), so the send site
  // supplies both phrases exactly as computed. Rows: Building, conditional
  // Customer, and the scheduled date.
  // --------------------------------------------------------------------------
  'job-assigned': {
    id: 'job-assigned',
    label: 'Job assigned (assessors)',
    description:
      'Tells an assessor a new job has been booked into their diary.',
    category: 'job-scheduled',
    audience: 'org-member',
    toggleAllowed: true,
    variables: [
      BUILDING_NAME,
      {
        name: 'job.subjectPhrase',
        label: 'Subject phrase: ‘New job today’ or ‘New job assigned’',
        example: 'New job assigned',
      },
      {
        name: 'job.headingPhrase',
        label: 'Heading: ‘A new job in your diary today’ or ‘A new job in your diary’',
        example: 'A new job in your diary',
      },
      {
        name: 'visit.date',
        label: 'Scheduled date (with the slot when one is set)',
        example: 'Tuesday, 11 August 2026, 09:00–11:00',
      },
    ],
    hasKindLink: true,
    hasKindRows: true,
    defaultTemplate: {
      subject: '{{job.subjectPhrase}}: {{building.name}}',
      preheader:
        'You have been assigned an assessment at {{building.name}}, scheduled for {{visit.date}}.',
      heading: '{{job.headingPhrase}}',
      blocks: [
        {
          id: 'p1',
          type: 'paragraph',
          text: 'You have been assigned an assessment at {{building.name}}, scheduled for {{visit.date}}.',
        },
        {
          id: 'p2',
          type: 'paragraph',
          text: 'Open the job for the building, its records and the assessment you will be carrying out.',
        },
        KIND_ROWS,
        { id: 'cta', type: 'cta', label: 'Open the job', useKindLink: true },
      ],
      footerNote: JOB_FOOTER,
    },
    delivery: 'collapse',
    digest: {
      noun: ['job', 'jobs'],
      ctaPath: '/app/jobs',
      defaultTemplate: {
        subject: '{{digest.countPhrase}} added to your diary',
        preheader:
          'You have {{digest.countPhrase}} newly booked into your diary.',
        heading: 'New jobs in your diary',
        blocks: [
          {
            id: 'p1',
            type: 'paragraph',
            text: 'You have {{digest.countPhrase}} newly booked into your diary.',
          },
          {
            id: 'p2',
            type: 'paragraph',
            text: 'Open your jobs for the buildings, their records and the assessments you will be carrying out.',
          },
          KIND_ROWS,
          { id: 'more', type: 'paragraph', text: '{{digest.moreNote}}', omitIfEmpty: true },
          { id: 'cta', type: 'cta', label: 'Open your jobs', useKindLink: true },
        ],
        footerNote: JOB_FOOTER,
      },
    },
  },

  // --------------------------------------------------------------------------
  // Source: lib/jobEmails.ts sendJobChangeEmail, called from
  // functions/rescheduleJob.ts. One kind covers the three assessor-side
  // variants a reschedule can produce - moved ('Job rescheduled' / 'Job moved
  // to today'), reassigned TO this assessor ('Job assigned to you'), and
  // reassigned AWAY from the replaced assessor ('Job reassigned', dated
  // against the visit's OLD slot) - because the lead sentence differs
  // structurally between them, the send site supplies it whole.
  // --------------------------------------------------------------------------
  'job-rescheduled': {
    id: 'job-rescheduled',
    label: 'Job rescheduled (assessors)',
    description:
      'Tells an assessor a job in their diary has moved, arrived from a reassignment, or left it.',
    category: 'job-scheduled',
    audience: 'org-member',
    toggleAllowed: true,
    variables: [
      BUILDING_NAME,
      {
        name: 'job.subjectPhrase',
        label: 'Subject phrase: ‘Job rescheduled’, ‘Job moved to today’, ‘Job assigned to you’ or ‘Job reassigned’',
        example: 'Job rescheduled',
      },
      {
        name: 'job.headingPhrase',
        label: 'Heading: ‘Your job has been rescheduled’, ‘A job has moved to your diary’ or ‘A job has left your diary’',
        example: 'Your job has been rescheduled',
      },
      {
        name: 'job.changeSummary',
        label: 'Lead sentence, exactly as computed today for the variant being sent',
        example:
          'Your assessment at Rose Court has been rescheduled to Tuesday, 11 August 2026, 09:00–11:00.',
      },
    ],
    hasKindLink: true,
    hasKindRows: true,
    defaultTemplate: {
      subject: '{{job.subjectPhrase}}: {{building.name}}',
      preheader: '{{job.changeSummary}}',
      heading: '{{job.headingPhrase}}',
      blocks: [
        { id: 'p1', type: 'paragraph', text: '{{job.changeSummary}}' },
        KIND_ROWS,
        { id: 'cta', type: 'cta', label: 'Open the job', useKindLink: true },
      ],
      footerNote: JOB_FOOTER,
    },
    // Collapse; a visit within 48 hours is sent immediately as urgent.
    delivery: 'collapse',
    digest: {
      noun: ['job', 'jobs'],
      ctaPath: '/app/jobs',
      defaultTemplate: {
        subject: 'Diary changes: {{digest.countPhrase}}',
        preheader: 'You have {{digest.countPhrase}} that changed today.',
        heading: 'Your diary has changed',
        blocks: [
          {
            id: 'p1',
            type: 'paragraph',
            text: 'You have {{digest.countPhrase}} that changed today: moved to a new date, assigned to you, or taken off your diary.',
          },
          {
            id: 'p2',
            type: 'paragraph',
            text: 'Open your jobs to see where each one now stands.',
          },
          KIND_ROWS,
          { id: 'more', type: 'paragraph', text: '{{digest.moreNote}}', omitIfEmpty: true },
          { id: 'cta', type: 'cta', label: 'Open your jobs', useKindLink: true },
        ],
        footerNote: JOB_FOOTER,
      },
    },
  },

  // --------------------------------------------------------------------------
  // Source: lib/jobEmails.ts sendJobChangeEmail, called from
  // functions/cancelJob.ts. The admin's reason travels as its own paragraph
  // when one was given, so it reads as their words - omitted entirely
  // otherwise.
  // --------------------------------------------------------------------------
  'job-cancelled': {
    id: 'job-cancelled',
    label: 'Job cancelled (assessors)',
    description:
      'Tells an assessor a job in their diary has been cancelled, with the admin’s reason when one was given.',
    category: 'job-scheduled',
    audience: 'org-member',
    toggleAllowed: true,
    variables: [
      BUILDING_NAME,
      {
        name: 'job.cancellationReason',
        label: 'The admin’s cancellation reason (empty when none was given)',
        example: 'The customer asked to postpone until October',
      },
    ],
    hasKindLink: true,
    hasKindRows: true,
    defaultTemplate: {
      subject: 'Job cancelled: {{building.name}}',
      preheader:
        'Your assessment at {{building.name}} has been cancelled, so there is nothing to attend.',
      heading: 'A job has been cancelled',
      blocks: [
        {
          id: 'p1',
          type: 'paragraph',
          text: 'Your assessment at {{building.name}} has been cancelled, so there is nothing to attend.',
        },
        {
          id: 'p2',
          type: 'paragraph',
          text: 'Reason given: {{job.cancellationReason}}',
          omitIfEmpty: true,
        },
        KIND_ROWS,
        { id: 'cta', type: 'cta', label: 'Open the job', useKindLink: true },
      ],
      footerNote: JOB_FOOTER,
    },
    // Collapse; a visit within 48 hours is sent immediately as urgent.
    delivery: 'collapse',
    digest: {
      noun: ['job', 'jobs'],
      ctaPath: '/app/jobs',
      defaultTemplate: {
        subject: '{{digest.countPhrase}} cancelled',
        preheader:
          'You have {{digest.countPhrase}} cancelled today, so there is nothing to attend.',
        heading: 'Jobs cancelled',
        blocks: [
          {
            id: 'p1',
            type: 'paragraph',
            text: 'You have {{digest.countPhrase}} cancelled today, so there is nothing to attend.',
          },
          {
            id: 'p2',
            type: 'paragraph',
            text: 'Any reason the administrator gave is listed beside the job.',
          },
          KIND_ROWS,
          { id: 'more', type: 'paragraph', text: '{{digest.moreNote}}', omitIfEmpty: true },
          { id: 'cta', type: 'cta', label: 'Open your jobs', useKindLink: true },
        ],
        footerNote: JOB_FOOTER,
      },
    },
  },

  // --------------------------------------------------------------------------
  // Source: lib/jobEmails.ts visitCustomerCopy, 'scheduled'. The kind link is
  // the contact's portal building page; the send site passes it only for
  // recipients with a live portal account, and the block simply drops for the
  // rest.
  // --------------------------------------------------------------------------
  'visit-scheduled': {
    id: 'visit-scheduled',
    label: 'Visit scheduled (customer contacts)',
    description:
      'Tells a building’s customer contacts that an assessment visit has been booked.',
    category: 'visit-scheduled',
    audience: 'customer-contact',
    toggleAllowed: true,
    variables: [
      ORG_NAME,
      BUILDING_NAME,
      {
        name: 'visit.place',
        label: 'The building with its site, e.g. ‘Rose Court, Meadow Business Park’',
        example: 'Rose Court, Meadow Business Park',
      },
      {
        name: 'visit.date',
        label: 'The visit’s day (with the slot when one is set)',
        example: 'Tuesday, 11 August 2026, 09:00–11:00',
      },
    ],
    hasKindLink: true,
    hasKindRows: true,
    defaultTemplate: {
      subject: 'Visit scheduled: {{building.name}}',
      preheader:
        '{{org.name}} will be visiting {{visit.place}} on {{visit.date}} to carry out a fire risk assessment.',
      heading: 'A visit has been scheduled',
      blocks: [
        {
          id: 'p1',
          type: 'paragraph',
          text: '{{org.name}} will be visiting {{visit.place}} on {{visit.date}} to carry out a fire risk assessment.',
        },
        {
          id: 'p2',
          type: 'paragraph',
          text: 'There is nothing you need to do, other than making sure the assessor can get in and reach the areas being assessed.',
        },
        {
          id: 'p3',
          type: 'paragraph',
          text: 'If the date does not suit, please contact {{org.name}} and another can be arranged.',
        },
        KIND_ROWS,
        { id: 'cta', type: 'cta', label: 'View your building', useKindLink: true },
      ],
      footerNote: VISIT_FOOTER,
    },
    delivery: 'collapse',
    digest: {
      noun: ['visit', 'visits'],
      ctaPath: '/app',
      defaultTemplate: {
        subject: '{{digest.countPhrase}} scheduled at your buildings',
        preheader:
          '{{org.name}} has scheduled {{digest.countPhrase}} at your buildings.',
        heading: 'Visits at your buildings',
        blocks: [
          {
            id: 'p1',
            type: 'paragraph',
            text: '{{org.name}} has scheduled {{digest.countPhrase}} at your buildings to carry out fire risk assessments.',
          },
          {
            id: 'p2',
            type: 'paragraph',
            text: 'There is nothing you need to do, other than making sure the assessor can get in and reach the areas being assessed.',
          },
          {
            id: 'p3',
            type: 'paragraph',
            text: 'If a date does not suit, please contact {{org.name}} and another can be arranged.',
          },
          KIND_ROWS,
          { id: 'more', type: 'paragraph', text: '{{digest.moreNote}}', omitIfEmpty: true },
          { id: 'cta', type: 'cta', label: 'View your buildings', useKindLink: true },
        ],
        footerNote: VISIT_DIGEST_FOOTER,
      },
    },
  },

  // --------------------------------------------------------------------------
  // Source: lib/jobEmails.ts visitCustomerCopy, 'rescheduled'.
  // --------------------------------------------------------------------------
  'visit-rescheduled': {
    id: 'visit-rescheduled',
    label: 'Visit rescheduled (customer contacts)',
    description:
      'Tells a building’s customer contacts that a booked visit has moved to a new date.',
    category: 'visit-rescheduled',
    audience: 'customer-contact',
    toggleAllowed: true,
    variables: [
      ORG_NAME,
      BUILDING_NAME,
      {
        name: 'visit.place',
        label: 'The building with its site, e.g. ‘Rose Court, Meadow Business Park’',
        example: 'Rose Court, Meadow Business Park',
      },
      {
        name: 'visit.date',
        label: 'The visit’s new day (with the slot when one is set)',
        example: 'Thursday, 13 August 2026, 13:00–15:00',
      },
    ],
    hasKindLink: true,
    hasKindRows: true,
    defaultTemplate: {
      subject: 'Visit rescheduled: {{building.name}}',
      preheader:
        'The visit to {{visit.place}} by {{org.name}} has been rescheduled. It is now planned for {{visit.date}}.',
      heading: 'Your visit has been rescheduled',
      blocks: [
        {
          id: 'p1',
          type: 'paragraph',
          text: 'The visit to {{visit.place}} by {{org.name}} has been rescheduled. It is now planned for {{visit.date}}.',
        },
        {
          id: 'p2',
          type: 'paragraph',
          text: 'There is nothing you need to do, other than making sure the assessor can get in and reach the areas being assessed.',
        },
        {
          id: 'p3',
          type: 'paragraph',
          text: 'If the date does not suit, please contact {{org.name}} and another can be arranged.',
        },
        KIND_ROWS,
        { id: 'cta', type: 'cta', label: 'View your building', useKindLink: true },
      ],
      footerNote: VISIT_FOOTER,
    },
    // Collapse; a visit within 48 hours is sent immediately as urgent.
    delivery: 'collapse',
    digest: {
      noun: ['visit', 'visits'],
      ctaPath: '/app',
      defaultTemplate: {
        subject: '{{digest.countPhrase}} rescheduled',
        preheader:
          '{{org.name}} has rescheduled {{digest.countPhrase}} at your buildings.',
        heading: 'Visits have been rescheduled',
        blocks: [
          {
            id: 'p1',
            type: 'paragraph',
            text: '{{org.name}} has rescheduled {{digest.countPhrase}} at your buildings. The new dates are listed below.',
          },
          {
            id: 'p2',
            type: 'paragraph',
            text: 'There is nothing you need to do, other than making sure the assessor can get in and reach the areas being assessed.',
          },
          {
            id: 'p3',
            type: 'paragraph',
            text: 'If a date does not suit, please contact {{org.name}} and another can be arranged.',
          },
          KIND_ROWS,
          { id: 'more', type: 'paragraph', text: '{{digest.moreNote}}', omitIfEmpty: true },
          { id: 'cta', type: 'cta', label: 'View your buildings', useKindLink: true },
        ],
        footerNote: VISIT_DIGEST_FOOTER,
      },
    },
  },

  // --------------------------------------------------------------------------
  // Source: lib/jobEmails.ts visitCustomerCopy, 'reassigned' - same date and
  // time, different assessor at reception.
  // --------------------------------------------------------------------------
  'visit-reassigned': {
    id: 'visit-reassigned',
    label: 'Visit reassigned (customer contacts)',
    description:
      'Tells a building’s customer contacts that a different assessor will now attend their booked visit.',
    category: 'visit-reassigned',
    audience: 'customer-contact',
    toggleAllowed: true,
    variables: [
      ORG_NAME,
      BUILDING_NAME,
      {
        name: 'visit.place',
        label: 'The building with its site, e.g. ‘Rose Court, Meadow Business Park’',
        example: 'Rose Court, Meadow Business Park',
      },
      {
        name: 'visit.date',
        label: 'The visit’s day (with the slot when one is set)',
        example: 'Tuesday, 11 August 2026, 09:00–11:00',
      },
    ],
    hasKindLink: true,
    hasKindRows: true,
    defaultTemplate: {
      subject: 'Visit update: {{building.name}}',
      preheader:
        'The visit to {{visit.place}} by {{org.name}} is going ahead as planned on {{visit.date}}, but a different assessor will now be attending.',
      heading: 'A different assessor will attend your visit',
      blocks: [
        {
          id: 'p1',
          type: 'paragraph',
          text: 'The visit to {{visit.place}} by {{org.name}} is going ahead as planned on {{visit.date}}, but a different assessor will now be attending.',
        },
        {
          id: 'p2',
          type: 'paragraph',
          text: 'There is nothing you need to do, other than making sure the assessor can get in and reach the areas being assessed.',
        },
        KIND_ROWS,
        { id: 'cta', type: 'cta', label: 'View your building', useKindLink: true },
      ],
      footerNote: VISIT_FOOTER,
    },
    // Collapse; a visit within 48 hours is sent immediately as urgent.
    delivery: 'collapse',
    digest: {
      noun: ['visit', 'visits'],
      ctaPath: '/app',
      defaultTemplate: {
        subject: 'Visit updates: {{digest.countPhrase}}',
        preheader:
          'A different assessor will now attend {{digest.countPhrase}} at your buildings.',
        heading: 'A different assessor will attend your visits',
        blocks: [
          {
            id: 'p1',
            type: 'paragraph',
            text: 'A different assessor will now attend {{digest.countPhrase}} at your buildings. The dates and times are unchanged.',
          },
          {
            id: 'p2',
            type: 'paragraph',
            text: 'There is nothing you need to do, other than making sure the assessor can get in and reach the areas being assessed.',
          },
          KIND_ROWS,
          { id: 'more', type: 'paragraph', text: '{{digest.moreNote}}', omitIfEmpty: true },
          { id: 'cta', type: 'cta', label: 'View your buildings', useKindLink: true },
        ],
        footerNote: VISIT_DIGEST_FOOTER,
      },
    },
  },

  // --------------------------------------------------------------------------
  // Source: lib/jobEmails.ts visitCustomerCopy, 'cancelled'. The admin's
  // reason keeps its own paragraph when given, omitted otherwise.
  // --------------------------------------------------------------------------
  'visit-cancelled': {
    id: 'visit-cancelled',
    label: 'Visit cancelled (customer contacts)',
    description:
      'Tells a building’s customer contacts that a booked visit has been cancelled and nobody will attend.',
    category: 'visit-cancelled',
    audience: 'customer-contact',
    toggleAllowed: true,
    variables: [
      ORG_NAME,
      BUILDING_NAME,
      {
        name: 'visit.place',
        label: 'The building with its site, e.g. ‘Rose Court, Meadow Business Park’',
        example: 'Rose Court, Meadow Business Park',
      },
      {
        name: 'visit.date',
        label: 'The day the visit was scheduled for (with the slot when one was set)',
        example: 'Tuesday, 11 August 2026, 09:00–11:00',
      },
      {
        name: 'visit.cancellationReason',
        label: 'The admin’s cancellation reason (empty when none was given)',
        example: 'The assessor is unwell',
      },
    ],
    hasKindLink: true,
    hasKindRows: true,
    defaultTemplate: {
      subject: 'Visit cancelled: {{building.name}}',
      preheader:
        'The visit to {{visit.place}} by {{org.name}}, scheduled for {{visit.date}}, has been cancelled. Nobody will be attending, and there is nothing you need to do.',
      heading: 'Your visit has been cancelled',
      blocks: [
        {
          id: 'p1',
          type: 'paragraph',
          text: 'The visit to {{visit.place}} by {{org.name}}, scheduled for {{visit.date}}, has been cancelled. Nobody will be attending, and there is nothing you need to do.',
        },
        {
          id: 'p2',
          type: 'paragraph',
          text: 'Reason given: {{visit.cancellationReason}}',
          omitIfEmpty: true,
        },
        {
          id: 'p3',
          type: 'paragraph',
          text: '{{org.name}} will be in touch if the visit needs to be rearranged.',
        },
        KIND_ROWS,
        { id: 'cta', type: 'cta', label: 'View your building', useKindLink: true },
      ],
      footerNote: VISIT_FOOTER,
    },
    // Collapse; a visit within 48 hours is sent immediately as urgent.
    delivery: 'collapse',
    digest: {
      noun: ['visit', 'visits'],
      ctaPath: '/app',
      defaultTemplate: {
        subject: '{{digest.countPhrase}} cancelled',
        preheader:
          '{{org.name}} has cancelled {{digest.countPhrase}} at your buildings. Nobody will be attending.',
        heading: 'Visits have been cancelled',
        blocks: [
          {
            id: 'p1',
            type: 'paragraph',
            text: '{{org.name}} has cancelled {{digest.countPhrase}} at your buildings. Nobody will be attending, and there is nothing you need to do.',
          },
          {
            id: 'p2',
            type: 'paragraph',
            text: 'Any reason given is listed beside the visit.',
          },
          {
            id: 'p3',
            type: 'paragraph',
            text: '{{org.name}} will be in touch if a visit needs to be rearranged.',
          },
          KIND_ROWS,
          { id: 'more', type: 'paragraph', text: '{{digest.moreNote}}', omitIfEmpty: true },
          { id: 'cta', type: 'cta', label: 'View your buildings', useKindLink: true },
        ],
        footerNote: VISIT_DIGEST_FOOTER,
      },
    },
  },

  // --------------------------------------------------------------------------
  // Source: functions/onAssessmentStageChange.ts, the readyForValidation
  // notice to every active auditor. Rows: Building, Assessor, and a
  // conditional Submitted timestamp.
  // --------------------------------------------------------------------------
  'awaiting-validation': {
    id: 'awaiting-validation',
    label: 'Awaiting validation (auditors)',
    description:
      'Tells auditors a submitted assessment is waiting in the validation queue.',
    category: 'awaiting-validation',
    audience: 'org-member',
    toggleAllowed: true,
    variables: [
      BUILDING_NAME,
      {
        name: 'assessor.name',
        label: 'The submitting assessor’s name',
        example: 'Sam Taylor',
      },
    ],
    hasKindLink: true,
    hasKindRows: true,
    defaultTemplate: {
      subject: 'An assessment is awaiting validation',
      preheader:
        '{{assessor.name}} has submitted a fire risk assessment of {{building.name}} for validation.',
      heading: 'An assessment is awaiting validation',
      blocks: [
        {
          id: 'p1',
          type: 'paragraph',
          text: '{{assessor.name}} has submitted a fire risk assessment of {{building.name}} for validation.',
        },
        {
          id: 'p2',
          type: 'paragraph',
          text: 'Please review it in the validation queue and accept it or request further information.',
        },
        KIND_ROWS,
        {
          id: 'cta',
          type: 'cta',
          label: 'Review the assessment',
          useKindLink: true,
        },
      ],
      footerNote:
        'You are receiving this because you are an auditor on Safentia.',
    },
    delivery: 'collapse',
    digest: {
      noun: ['assessment', 'assessments'],
      ctaPath: '/app/validation',
      defaultTemplate: {
        subject: '{{digest.countPhrase}} awaiting validation',
        preheader:
          'The validation queue has {{digest.countPhrase}} waiting for review.',
        heading: 'Assessments awaiting validation',
        blocks: [
          {
            id: 'p1',
            type: 'paragraph',
            text: 'The validation queue has {{digest.countPhrase}} waiting for review.',
          },
          {
            id: 'p2',
            type: 'paragraph',
            text: 'Please review each one and accept it or request further information.',
          },
          KIND_ROWS,
          { id: 'more', type: 'paragraph', text: '{{digest.moreNote}}', omitIfEmpty: true },
          { id: 'cta', type: 'cta', label: 'Open the validation queue', useKindLink: true },
        ],
        footerNote:
          'You are receiving this because you are an auditor on Safentia.',
      },
    },
  },

  // --------------------------------------------------------------------------
  // Source: functions/onAssessmentStageChange.ts, the released notice to
  // active admins.
  // --------------------------------------------------------------------------
  'released-admin': {
    id: 'released-admin',
    label: 'Report released (admins)',
    description:
      'Tells administrators a validated assessment has been released and its report is available.',
    category: 'released',
    audience: 'org-member',
    toggleAllowed: true,
    variables: [
      BUILDING_NAME,
      {
        name: 'assessment.releasedAt',
        label: 'When the release happened',
        example: '6 August 2026, 14:32',
      },
    ],
    hasKindLink: true,
    hasKindRows: false,
    defaultTemplate: {
      subject:
        'A new fire risk assessment report is available for {{building.name}}',
      preheader:
        'The fire risk assessment of {{building.name}} has been validated and released, and its report is now available.',
      heading: 'Assessment released',
      blocks: [
        {
          id: 'p1',
          type: 'paragraph',
          text: 'The fire risk assessment of {{building.name}} has been validated and released, and its report is now available.',
        },
        {
          id: 'rows',
          type: 'detail-rows',
          source: 'custom',
          rows: [
            { id: 'building', label: 'Building', value: '{{building.name}}' },
            {
              id: 'released',
              label: 'Released',
              value: '{{assessment.releasedAt}}',
            },
          ],
        },
        {
          id: 'cta',
          type: 'cta',
          label: 'View the assessment',
          useKindLink: true,
        },
      ],
      footerNote:
        'You are receiving this because you are an administrator on Safentia.',
    },
    delivery: 'collapse',
    digest: {
      noun: ['assessment', 'assessments'],
      ctaPath: '/app/customers',
      defaultTemplate: {
        subject: 'New fire risk assessment reports: {{digest.countPhrase}}',
        preheader:
          'Reports are now available for {{digest.countPhrase}} released today.',
        heading: '{{org.name}}: assessments released',
        blocks: [
          {
            id: 'p1',
            type: 'paragraph',
            text: 'Your team has released {{digest.countPhrase}} today, and the reports are now available.',
          },
          {
            id: 'p2',
            type: 'paragraph',
            text: 'Open a customer to read a report or to share it with the building’s contacts.',
          },
          KIND_ROWS,
          { id: 'more', type: 'paragraph', text: '{{digest.moreNote}}', omitIfEmpty: true },
          { id: 'cta', type: 'cta', label: 'View your customers', useKindLink: true },
        ],
        footerNote:
          'You are receiving this because you are an administrator on Safentia.',
      },
    },
  },

  // --------------------------------------------------------------------------
  // Source: functions/onAssessmentStageChange.ts, the released notice to the
  // customer's contacts. The second paragraph differs between the accept-and-
  // sign-off flow (a report id is in hand) and the no-report fallback, so the
  // send site supplies the sentence it computes today. The CTA label 'Accept &
  // Sign Off' is the accept-flow one (the fallback sends 'View your report in
  // the portal' with the building page as its kind link).
  // --------------------------------------------------------------------------
  'released-contact': {
    id: 'released-contact',
    label: 'Report released (customer contacts)',
    description:
      'Tells a building’s customer contacts a released report is ready to read, accept and download in their portal.',
    category: 'released',
    audience: 'customer-contact',
    toggleAllowed: true,
    variables: [
      BUILDING_NAME,
      {
        name: 'report.accessInstruction',
        label: 'Portal instruction sentences, exactly as computed today for the accept-flow or no-report case',
        example:
          'Sign in to your Safentia portal to read and accept the report. You will be asked to type your name to sign it off, and the report is available to download straight afterwards.',
      },
    ],
    hasKindLink: true,
    hasKindRows: false,
    defaultTemplate: {
      subject:
        'A new fire risk assessment report is available for {{building.name}}',
      preheader:
        'The fire risk assessment of {{building.name}} has been validated and released, and its report is now available.',
      heading:
        'A new fire risk assessment report is available for {{building.name}}',
      blocks: [
        {
          id: 'p1',
          type: 'paragraph',
          text: 'The fire risk assessment of {{building.name}} has been validated and released, and its report is now available.',
        },
        { id: 'p2', type: 'paragraph', text: '{{report.accessInstruction}}' },
        {
          id: 'rows',
          type: 'detail-rows',
          source: 'custom',
          rows: [
            { id: 'building', label: 'Building', value: '{{building.name}}' },
          ],
        },
        { id: 'cta', type: 'cta', label: 'Accept & Sign Off', useKindLink: true },
      ],
      footerNote:
        'You are receiving this because you are a contact for {{building.name}} on Safentia.',
    },
    delivery: 'collapse',
    digest: {
      noun: ['report', 'reports'],
      ctaPath: '/app',
      defaultTemplate: {
        subject: '{{digest.countPhrase}} ready to read in your portal',
        preheader:
          'You have {{digest.countPhrase}} to read and accept in your Safentia portal.',
        heading: 'New fire risk assessment reports',
        blocks: [
          {
            id: 'p1',
            type: 'paragraph',
            text: 'You have {{digest.countPhrase}} waiting in your Safentia portal.',
          },
          {
            id: 'p2',
            type: 'paragraph',
            text: 'Sign in to read and accept each one. You will be asked to type your name to sign a report off, and it is available to download straight afterwards.',
          },
          KIND_ROWS,
          { id: 'more', type: 'paragraph', text: '{{digest.moreNote}}', omitIfEmpty: true },
          { id: 'cta', type: 'cta', label: 'Open your portal', useKindLink: true },
        ],
        footerNote: CONTACT_DIGEST_FOOTER,
      },
    },
  },

  // --------------------------------------------------------------------------
  // Source: functions/onAssessmentStageChange.ts, the assigned assessor's
  // outcome notice, covering both verdicts - accepted (readyForRelease) and
  // released - whose sentences differ structurally, so the send site supplies
  // them exactly as computed today. Rows carry conditional Customer and
  // Accepted by / Released by entries. NOTE: the send site currently logs
  // these under 'assessment-accepted' / 'assessment-released'; the catalogue
  // files the kind under the released family's category, and the refactor
  // unifies the log on it.
  // --------------------------------------------------------------------------
  'released-assessor': {
    id: 'released-assessor',
    label: 'Assessment outcome (assessors)',
    description:
      'Tells the assessor their submitted assessment has been accepted for release, or released to the customer.',
    category: 'released',
    audience: 'org-member',
    toggleAllowed: true,
    variables: [
      BUILDING_NAME,
      {
        name: 'assessment.outcomePhrase',
        label: 'Outcome word: ‘accepted’ or ‘released’',
        example: 'accepted',
      },
      {
        name: 'assessment.outcomeSummary',
        label: 'Lead sentence, exactly as computed today for the accepted or released case',
        example:
          'Your fire risk assessment of Rose Court has been reviewed and accepted by Alex Morgan. It is cleared for release.',
      },
      {
        name: 'assessment.outcomeDetail',
        label: 'Second sentence, exactly as computed today for the accepted or released case',
        example:
          'Nothing further is needed from you. You will hear again when it is released.',
      },
    ],
    hasKindLink: true,
    hasKindRows: true,
    defaultTemplate: {
      subject:
        'Your assessment of {{building.name}} has been {{assessment.outcomePhrase}}',
      preheader: '{{assessment.outcomeSummary}}',
      heading: 'Assessment {{assessment.outcomePhrase}}',
      blocks: [
        { id: 'p1', type: 'paragraph', text: '{{assessment.outcomeSummary}}' },
        { id: 'p2', type: 'paragraph', text: '{{assessment.outcomeDetail}}' },
        KIND_ROWS,
        { id: 'cta', type: 'cta', label: 'Open the job', useKindLink: true },
      ],
      footerNote: ASSESSOR_FOOTER,
    },
    delivery: 'collapse',
    digest: {
      noun: ['assessment', 'assessments'],
      ctaPath: '/app/jobs',
      defaultTemplate: {
        subject: 'Updates on {{digest.countPhrase}} you submitted',
        preheader:
          'You have an update on {{digest.countPhrase}} you submitted.',
        heading: 'Updates on your assessments',
        blocks: [
          {
            id: 'p1',
            type: 'paragraph',
            text: 'You have an update on {{digest.countPhrase}} you submitted.',
          },
          {
            id: 'p2',
            type: 'paragraph',
            text: 'Each has been accepted for release or released to the customer; the outcome is listed beside it. Nothing further is needed from you.',
          },
          KIND_ROWS,
          { id: 'more', type: 'paragraph', text: '{{digest.moreNote}}', omitIfEmpty: true },
          { id: 'cta', type: 'cta', label: 'Open your jobs', useKindLink: true },
        ],
        footerNote: ASSESSOR_FOOTER,
      },
    },
  },

  // --------------------------------------------------------------------------
  // Source: functions/releaseAssessment.ts, the per-contact digest of actions
  // recorded against them by a released assessment. Rows: Building, Actions,
  // Top severity, and a conditional Earliest due.
  // --------------------------------------------------------------------------
  'release-digest': {
    id: 'release-digest',
    label: 'Release action digest (responsible contacts)',
    description:
      'Tells each responsible contact which actions a newly released assessment has recorded against them.',
    category: 'release-digest',
    audience: 'customer-contact',
    toggleAllowed: true,
    variables: [
      BUILDING_NAME,
      {
        name: 'actions.countPhrase',
        label: 'Action count phrase, e.g. ‘1 action’ or ‘3 actions’',
        example: '3 actions',
      },
    ],
    hasKindLink: true,
    hasKindRows: true,
    defaultTemplate: {
      subject:
        '{{actions.countPhrase}} from the released assessment of {{building.name}}',
      preheader:
        'A fire risk assessment of {{building.name}} has been released with {{actions.countPhrase}} recorded against you.',
      heading:
        '{{actions.countPhrase}} from the released assessment of {{building.name}}',
      blocks: [
        {
          id: 'p1',
          type: 'paragraph',
          text: 'A fire risk assessment of {{building.name}} has been released with {{actions.countPhrase}} recorded against you.',
        },
        {
          id: 'p2',
          type: 'paragraph',
          text: 'Please review the action plan and arrange the remedial work before the due dates pass.',
        },
        KIND_ROWS,
        {
          id: 'cta',
          type: 'cta',
          label: 'View the action plan',
          useKindLink: true,
        },
      ],
      footerNote:
        'You are receiving this because you are recorded as responsible for these actions at {{building.name}} on Safentia.',
    },
    delivery: 'collapse',
    digest: {
      noun: ['action', 'actions'],
      ctaPath: '/app',
      defaultTemplate: {
        subject: '{{digest.countPhrase}} from newly released assessments',
        preheader:
          'You have {{digest.countPhrase}} recorded against you by assessments released today.',
        heading: 'Actions from released assessments',
        blocks: [
          {
            id: 'p1',
            type: 'paragraph',
            text: 'You have {{digest.countPhrase}} recorded against you by fire risk assessments released today.',
          },
          {
            id: 'p2',
            type: 'paragraph',
            text: 'Please review the action plans and arrange the remedial work before the due dates pass.',
          },
          KIND_ROWS,
          { id: 'more', type: 'paragraph', text: '{{digest.moreNote}}', omitIfEmpty: true },
          { id: 'cta', type: 'cta', label: 'View your action plans', useKindLink: true },
        ],
        footerNote: RESPONSIBLE_DIGEST_FOOTER,
      },
    },
  },

  // --------------------------------------------------------------------------
  // Source: functions/requestInfo.ts sendInfoRequestedEmail.
  // --------------------------------------------------------------------------
  'info-requested': {
    id: 'info-requested',
    label: 'Information requested (assessors)',
    description:
      'Tells the assessor an auditor has asked for more information on their submitted assessment, and by when.',
    category: 'info-requested',
    audience: 'org-member',
    toggleAllowed: true,
    variables: [
      BUILDING_NAME,
      {
        name: 'info.flaggedPhrase',
        label: 'Flagged question count phrase, e.g. ‘1 question’ or ‘3 questions’',
        example: '3 questions',
      },
      {
        name: 'info.dueDate',
        label: 'Response due date',
        example: '14 August 2026',
      },
    ],
    hasKindLink: true,
    hasKindRows: false,
    defaultTemplate: {
      subject:
        'More information needed on your assessment of {{building.name}}',
      preheader:
        'An auditor has asked for more information on {{info.flaggedPhrase}} in your fire risk assessment of {{building.name}}.',
      heading: 'More information required',
      blocks: [
        {
          id: 'p1',
          type: 'paragraph',
          text: 'An auditor has asked for more information on {{info.flaggedPhrase}} in your fire risk assessment of {{building.name}}.',
        },
        {
          id: 'p2',
          type: 'paragraph',
          text: 'Open the assessment, answer each flagged question and resubmit it. The assessment returns to the validation queue once you do.',
        },
        {
          id: 'rows',
          type: 'detail-rows',
          source: 'custom',
          rows: [
            { id: 'building', label: 'Building', value: '{{building.name}}' },
            {
              id: 'flagged',
              label: 'Questions flagged',
              value: '{{info.flaggedPhrase}}',
            },
            { id: 'due', label: 'Response due by', value: '{{info.dueDate}}' },
          ],
        },
        { id: 'cta', type: 'cta', label: 'Open the job', useKindLink: true },
      ],
      footerNote: ASSESSOR_FOOTER,
    },
    delivery: 'collapse',
    digest: {
      noun: ['assessment', 'assessments'],
      ctaPath: '/app/jobs',
      defaultTemplate: {
        subject: 'More information needed on {{digest.countPhrase}}',
        preheader:
          'An auditor has asked for more information on {{digest.countPhrase}} you submitted.',
        heading: 'More information required',
        blocks: [
          {
            id: 'p1',
            type: 'paragraph',
            text: 'An auditor has asked for more information on {{digest.countPhrase}} you submitted.',
          },
          {
            id: 'p2',
            type: 'paragraph',
            text: 'Open each job, answer the flagged questions and resubmit it. An assessment returns to the validation queue once you do.',
          },
          KIND_ROWS,
          { id: 'more', type: 'paragraph', text: '{{digest.moreNote}}', omitIfEmpty: true },
          { id: 'cta', type: 'cta', label: 'Open your jobs', useKindLink: true },
        ],
        footerNote: ASSESSOR_FOOTER,
      },
    },
  },

  // --------------------------------------------------------------------------
  // Source: functions/manageAction.ts, the assignment notice to a responsible
  // contact. Rows: Building, Observation, Severity, and conditional Due by
  // and Life protection entries.
  // --------------------------------------------------------------------------
  'action-assigned': {
    id: 'action-assigned',
    label: 'Action assigned (responsible contacts)',
    description:
      'Tells a customer contact a fire-safety action has been assigned to them as the responsible party.',
    category: 'action-assigned',
    audience: 'customer-contact',
    toggleAllowed: true,
    variables: [BUILDING_NAME],
    hasKindLink: true,
    hasKindRows: true,
    defaultTemplate: {
      subject: 'An action has been assigned to you',
      preheader:
        'A fire-safety action at {{building.name}} has been assigned to you on Safentia.',
      heading: 'An action has been assigned to you',
      blocks: [
        {
          id: 'p1',
          type: 'paragraph',
          text: 'A fire-safety action at {{building.name}} has been assigned to you on Safentia.',
        },
        {
          id: 'p2',
          type: 'paragraph',
          text: 'Please review the detail below and arrange the remedial work before the due date passes.',
        },
        KIND_ROWS,
        {
          id: 'cta',
          type: 'cta',
          label: 'View the action plan',
          useKindLink: true,
        },
      ],
      footerNote:
        'You are receiving this because you are recorded as responsible for this action at {{building.name}} on Safentia.',
    },
    delivery: 'collapse',
    digest: {
      noun: ['action', 'actions'],
      ctaPath: '/app',
      defaultTemplate: {
        subject: '{{digest.countPhrase}} assigned to you',
        preheader:
          'You have {{digest.countPhrase}} newly assigned to you on Safentia.',
        heading: 'Actions assigned to you',
        blocks: [
          {
            id: 'p1',
            type: 'paragraph',
            text: 'You have {{digest.countPhrase}} newly assigned to you as the responsible party.',
          },
          {
            id: 'p2',
            type: 'paragraph',
            text: 'Please review the detail below and arrange the remedial work before the due dates pass.',
          },
          KIND_ROWS,
          { id: 'more', type: 'paragraph', text: '{{digest.moreNote}}', omitIfEmpty: true },
          { id: 'cta', type: 'cta', label: 'View your action plans', useKindLink: true },
        ],
        footerNote: RESPONSIBLE_DIGEST_FOOTER,
      },
    },
  },

  // --------------------------------------------------------------------------
  // Source: functions/manageCustomerContact.ts notifyAdminsOfFieldContact.
  // Rows carry several conditional entries (Role, Phone, Report copies), so
  // the send site supplies the card it builds today.
  // --------------------------------------------------------------------------
  'field-contact-added': {
    id: 'field-contact-added',
    label: 'Contact added on site (admins)',
    description:
      'Tells administrators an assessor recorded a new customer contact while on site, and that inviting them is the admin’s decision.',
    category: 'field-contact-added',
    audience: 'org-member',
    toggleAllowed: true,
    variables: [
      ORG_NAME,
      {
        name: 'assessor.name',
        label: 'The assessor who added the contact',
        example: 'Sam Taylor',
      },
      {
        name: 'contact.name',
        label: 'The new contact’s name',
        example: 'Priya Shah',
      },
      {
        name: 'customer.name',
        label: 'Customer name',
        example: 'Meadow Housing Association',
      },
    ],
    hasKindLink: true,
    hasKindRows: true,
    defaultTemplate: {
      subject: 'New contact added on site: {{contact.name}} ({{customer.name}})',
      preheader:
        '{{assessor.name}} added {{contact.name}} as a contact for {{customer.name}} while on site. They can now be named as a responsible party and emailed about reports and actions.',
      heading: '{{org.name}}: a contact was added from the field',
      blocks: [
        {
          id: 'p1',
          type: 'paragraph',
          text: '{{assessor.name}} added {{contact.name}} as a contact for {{customer.name}} while on site. They can now be named as a responsible party and emailed about reports and actions.',
        },
        {
          id: 'p2',
          type: 'paragraph',
          text: 'Assessors can record who a person is, but not grant them access. If this person should be able to sign in and read their reports and action plan, invite them to the portal from the customer record.',
        },
        KIND_ROWS,
        {
          id: 'cta',
          type: 'cta',
          label: 'View the customer and invite them',
          useKindLink: true,
        },
      ],
      footerNote: ORG_ADMIN_FOOTER,
    },
    delivery: 'collapse',
    digest: {
      noun: ['contact', 'contacts'],
      ctaPath: '/app/customers',
      defaultTemplate: {
        subject: '{{digest.countPhrase}} added on site',
        preheader:
          'Assessors added {{digest.countPhrase}} to your customer records while on site.',
        heading: '{{org.name}}: contacts added from the field',
        blocks: [
          {
            id: 'p1',
            type: 'paragraph',
            text: 'Assessors added {{digest.countPhrase}} to your customer records while on site. They can now be named as responsible parties and emailed about reports and actions.',
          },
          {
            id: 'p2',
            type: 'paragraph',
            text: 'Assessors can record who a person is, but not grant them access. If any of these people should be able to sign in and read their reports and action plan, invite them to the portal from the customer record.',
          },
          KIND_ROWS,
          { id: 'more', type: 'paragraph', text: '{{digest.moreNote}}', omitIfEmpty: true },
          { id: 'cta', type: 'cta', label: 'View your customers', useKindLink: true },
        ],
        footerNote: ORG_ADMIN_FOOTER,
      },
    },
  },

  // --------------------------------------------------------------------------
  // Source: functions/customerContracts.ts, the contract-end sweep's admin
  // notice.
  // --------------------------------------------------------------------------
  'contract-ended': {
    id: 'contract-ended',
    label: 'Contract ended (admins)',
    description:
      'Tells administrators a customer’s contract has ended, so they have been archived and their portal access withdrawn.',
    category: 'contract-ended',
    audience: 'org-member',
    toggleAllowed: true,
    variables: [
      ORG_NAME,
      {
        name: 'customer.name',
        label: 'Customer name',
        example: 'Meadow Housing Association',
      },
      {
        name: 'contract.endDate',
        label: 'Contract end date',
        example: '31 July 2026',
      },
    ],
    hasKindLink: true,
    hasKindRows: false,
    defaultTemplate: {
      subject: 'Contract ended: {{customer.name}}',
      preheader:
        'The contract with {{customer.name}} ended on {{contract.endDate}}. They have been archived and their portal access has been withdrawn.',
      heading: '{{org.name}}: a customer contract has ended',
      blocks: [
        {
          id: 'p1',
          type: 'paragraph',
          text: 'The contract with {{customer.name}} ended on {{contract.endDate}}. They have been archived and their portal access has been withdrawn.',
        },
        {
          id: 'p2',
          type: 'paragraph',
          text: 'Their sites, buildings and assessment history are unchanged and stay in your records. Restore the customer if the contract has been renewed - that returns the portal access this withdrew.',
        },
        {
          id: 'rows',
          type: 'detail-rows',
          source: 'custom',
          rows: [
            { id: 'customer', label: 'Customer', value: '{{customer.name}}' },
            {
              id: 'ended',
              label: 'Contract ended',
              value: '{{contract.endDate}}',
            },
          ],
        },
        { id: 'cta', type: 'cta', label: 'View the customer', useKindLink: true },
      ],
      footerNote: ORG_ADMIN_FOOTER,
    },
    // Digest: the contract-end sweep, which runs before the flush.
    delivery: 'digest',
    digest: {
      noun: ['customer', 'customers'],
      ctaPath: '/app/customers',
      defaultTemplate: {
        subject: 'Contracts ended: {{digest.countPhrase}}',
        preheader:
          'Contracts with {{digest.countPhrase}} have ended, and their portal access has been withdrawn.',
        heading: '{{org.name}}: customer contracts have ended',
        blocks: [
          {
            id: 'p1',
            type: 'paragraph',
            text: 'The contracts with {{digest.countPhrase}} have ended. They have been archived and their portal access has been withdrawn.',
          },
          {
            id: 'p2',
            type: 'paragraph',
            text: 'Their sites, buildings and assessment history are unchanged and stay in your records. Restore a customer if the contract has been renewed - that returns the portal access this withdrew.',
          },
          KIND_ROWS,
          { id: 'more', type: 'paragraph', text: '{{digest.moreNote}}', omitIfEmpty: true },
          { id: 'cta', type: 'cta', label: 'View your customers', useKindLink: true },
        ],
        footerNote: ORG_ADMIN_FOOTER,
      },
    },
  },

  // --------------------------------------------------------------------------
  // Source: functions/stripeWebhook.ts, the dunning notice sent to the org's
  // admins on the FIRST invoice.payment_failed of a dunning cycle (never on
  // retries - the webhook checks the prior paymentState). Unlike the kinds
  // above there is no hardcoded predecessor: billing emails were born on the
  // templating seam. toggleAllowed is FALSE for the same reason as
  // 'invitation': a failed payment is operationally critical - it is the only
  // warning an organisation gets before its access pauses, so no admin may
  // silence it for everyone and discover the suspension by surprise.
  // --------------------------------------------------------------------------
  'payment-failed': {
    id: 'payment-failed',
    label: 'Payment failed (admins)',
    description:
      'Tells administrators a subscription payment did not go through, and by when the card must be updated to avoid a pause.',
    category: 'billing',
    audience: 'org-member',
    toggleAllowed: false,
    variables: [
      ORG_NAME,
      {
        name: 'invoice.amountFormatted',
        label: 'Amount due',
        example: '£129.00',
      },
      {
        name: 'invoice.number',
        label: 'Invoice number',
        example: 'SAFENTIA-0042',
      },
      {
        name: 'grace.endDate',
        label: 'Grace period end date',
        example: '24 August 2026',
      },
    ],
    hasKindLink: true,
    hasKindRows: false,
    defaultTemplate: {
      subject: 'Payment failed for {{org.name}}',
      preheader:
        'A payment of {{invoice.amountFormatted}} did not go through. Your access is unchanged while the card is retried.',
      heading: '{{org.name}}: a payment did not go through',
      blocks: [
        {
          id: 'p1',
          type: 'paragraph',
          text: 'The payment of {{invoice.amountFormatted}} for your Safentia subscription (invoice {{invoice.number}}) did not go through.',
        },
        {
          id: 'p2',
          type: 'paragraph',
          text: 'Nothing has changed for your team: everyone keeps full access while the card is retried automatically over the next few days.',
        },
        {
          id: 'p3',
          type: 'paragraph',
          text: 'To put things right straight away, update your payment card from the Billing page. If payment has not been collected by {{grace.endDate}}, new work will be paused until it is.',
        },
        {
          id: 'rows',
          type: 'detail-rows',
          source: 'custom',
          rows: [
            {
              id: 'amount',
              label: 'Amount due',
              value: '{{invoice.amountFormatted}}',
            },
            { id: 'invoice', label: 'Invoice', value: '{{invoice.number}}' },
            {
              id: 'by',
              label: 'Update your card by',
              value: '{{grace.endDate}}',
            },
          ],
        },
        {
          id: 'cta',
          type: 'cta',
          label: 'Update your payment card',
          useKindLink: true,
        },
      ],
      footerNote: ORG_ADMIN_FOOTER,
    },
    // Immediate: the only warning before an organisation’s access pauses.
    delivery: 'immediate',
  },

  // --------------------------------------------------------------------------
  // Source: functions/stripeWebhook.ts, sent to the org's admins on every
  // invoice.paid whose amount is above zero (a £0 invoice is bookkeeping, not
  // a payment worth a receipt). The hosted invoice URL travels as a variable
  // in the body text - a second link alongside the Billing CTA - because
  // Stripe's hosted page is where the formal PDF lives.
  // --------------------------------------------------------------------------
  'payment-receipt': {
    id: 'payment-receipt',
    label: 'Payment receipt (admins)',
    description:
      'Sends administrators a receipt each time a subscription payment is collected successfully.',
    category: 'billing',
    audience: 'org-member',
    toggleAllowed: true,
    variables: [
      ORG_NAME,
      {
        name: 'invoice.amountFormatted',
        label: 'Amount paid',
        example: '£129.00',
      },
      {
        name: 'invoice.number',
        label: 'Invoice number',
        example: 'SAFENTIA-0042',
      },
      { name: 'plan.name', label: 'Plan name', example: 'Silver' },
      {
        name: 'period.endDate',
        label: 'Paid-up-to date',
        example: '10 September 2026',
      },
      {
        name: 'invoice.url',
        label: 'Stripe hosted invoice link',
        example: 'https://invoice.stripe.com/i/inv_abc123',
      },
    ],
    hasKindLink: true,
    hasKindRows: false,
    defaultTemplate: {
      subject: 'Receipt: {{invoice.amountFormatted}} — {{org.name}}',
      preheader:
        'Your Safentia subscription payment has been received. Thank you.',
      heading: 'Thank you — payment received',
      blocks: [
        {
          id: 'p1',
          type: 'paragraph',
          text: 'We have received your payment of {{invoice.amountFormatted}} for the {{plan.name}} plan.',
        },
        {
          id: 'rows',
          type: 'detail-rows',
          source: 'custom',
          rows: [
            {
              id: 'amount',
              label: 'Amount paid',
              value: '{{invoice.amountFormatted}}',
            },
            { id: 'plan', label: 'Plan', value: '{{plan.name}}' },
            { id: 'invoice', label: 'Invoice', value: '{{invoice.number}}' },
            { id: 'until', label: 'Paid up to', value: '{{period.endDate}}' },
          ],
        },
        {
          id: 'p2',
          type: 'paragraph',
          text: 'You can view or download the invoice at any time: {{invoice.url}}',
          // A payment collected outside the usual invoice flow may carry no
          // hosted page; the line simply drops rather than pointing nowhere.
          omitIfEmpty: true,
        },
        { id: 'cta', type: 'cta', label: 'View billing', useKindLink: true },
      ],
      footerNote: ORG_ADMIN_FOOTER,
    },
    // Collapse: the first receipt of the day is news, the fifth is noise.
    delivery: 'collapse',
    digest: {
      noun: ['payment', 'payments'],
      ctaPath: '/app/billing',
      defaultTemplate: {
        subject: 'Receipts for {{digest.countPhrase}} — {{org.name}}',
        preheader:
          'We have received {{digest.countPhrase}} for your Safentia subscription. Thank you.',
        heading: 'Thank you — payments received',
        blocks: [
          {
            id: 'p1',
            type: 'paragraph',
            text: 'We have received {{digest.countPhrase}} for your Safentia subscription. Each one is listed below with its invoice.',
          },
          {
            id: 'p2',
            type: 'paragraph',
            text: 'You can view or download any invoice from the Billing page.',
          },
          KIND_ROWS,
          { id: 'more', type: 'paragraph', text: '{{digest.moreNote}}', omitIfEmpty: true },
          { id: 'cta', type: 'cta', label: 'View billing', useKindLink: true },
        ],
        footerNote: ORG_ADMIN_FOOTER,
      },
    },
  },

  // --------------------------------------------------------------------------
  // Source: functions/stripeWebhook.ts, sent to the org's admins once when the
  // subscription terminally ends - the final cancellation
  // (customer.subscription.deleted) or the transition to unpaid after the
  // dunning retries are exhausted, whichever lands first. toggleAllowed is
  // FALSE like 'payment-failed': the organisation's access has materially
  // changed, and an email kind an admin might have silenced months earlier
  // must not be the reason nobody was told.
  // --------------------------------------------------------------------------
  'subscription-ended': {
    id: 'subscription-ended',
    label: 'Subscription ended (admins)',
    description:
      'Tells administrators the subscription has ended, exactly what that pauses, and how to restart it.',
    category: 'billing',
    audience: 'org-member',
    toggleAllowed: false,
    variables: [ORG_NAME],
    hasKindLink: true,
    hasKindRows: false,
    defaultTemplate: {
      subject: 'Your Safentia subscription has ended',
      preheader:
        'New work is paused for {{org.name}}. Your records are safe, and you can restart at any time.',
      heading: '{{org.name}}: your subscription has ended',
      blocks: [
        {
          id: 'p1',
          type: 'paragraph',
          text: 'Your organisation’s Safentia subscription has ended, so creating new jobs, assessments, customers and invitations is paused.',
        },
        {
          id: 'p2',
          type: 'paragraph',
          text: 'Nothing has been deleted: every record, report and assessment remains available to read, and work already in progress can still be completed.',
        },
        {
          id: 'p3',
          type: 'paragraph',
          text: 'To pick up where you left off, restart your subscription from the Billing page.',
        },
        {
          id: 'cta',
          type: 'cta',
          label: 'Restart your subscription',
          useKindLink: true,
        },
      ],
      footerNote: ORG_ADMIN_FOOTER,
    },
    // Immediate: the organisation’s access has materially changed.
    delivery: 'immediate',
  },

  // --------------------------------------------------------------------------
  // The admin-composed send. No hardcoded predecessor to transcribe: this is
  // a generic starting point the composer opens with, and everything about it
  // is the admin's to write.
  // --------------------------------------------------------------------------
  manual: {
    id: 'manual',
    label: 'Manual email',
    description:
      'An email an administrator composes and sends themselves, starting from this blank message.',
    category: 'manual',
    audience: 'manual',
    toggleAllowed: false,
    variables: [
      ORG_NAME,
      {
        name: 'recipient.name',
        label: 'Recipient’s name',
        example: 'Jordan Lee',
      },
      {
        name: 'recipient.email',
        label: 'Recipient’s email address',
        example: 'jordan@example.com',
      },
    ],
    hasKindLink: false,
    hasKindRows: false,
    defaultTemplate: {
      subject: 'A message from {{org.name}}',
      heading: '{{org.name}}',
      blocks: [
        { id: 'p1', type: 'paragraph', text: 'Write your message here.' },
      ],
    },
    // Immediate: an administrator composed it and pressed send.
    delivery: 'immediate',
  },
};

/** Look a kind up; the Record is total over EmailKindId, so this is a plain
 *  index with a friendlier name for call sites. */
export function emailKind(id: EmailKindId): EmailKindDefinition {
  return EMAIL_KINDS[id];
}

/** Kinds shown in the console settings matrix (everything except 'manual',
 *  which has no toggle or default copy worth a row). Catalogue order. */
export const CONFIGURABLE_EMAIL_KIND_IDS: EmailKindId[] = (
  Object.keys(EMAIL_KINDS) as EmailKindId[]
).filter((id) => id !== 'manual');
