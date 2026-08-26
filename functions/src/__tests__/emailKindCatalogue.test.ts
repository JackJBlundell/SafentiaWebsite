// ============================================================================
// emailKindCatalogue tests - structural guarantees over the copy-sensitive
// catalogue: the kind set matches the schema vocabulary, every default
// template is well-formed and renderable, every {{variable}} a template uses
// is declared, the toggle policy holds, kind-rows claims are backed by a
// kind-sourced block, and a handful of subjects/labels are spot-checked
// verbatim against the send sites they were extracted from.
// ============================================================================

import { EMAIL_DELIVERY_POLICIES, EMAIL_KIND_IDS } from '../shared/types';
import type { EmailKindId, EmailTemplateBlock } from '../shared/types';
import {
  CONFIGURABLE_EMAIL_KIND_IDS,
  EMAIL_KINDS,
  emailKind,
  type EmailKindDefinition,
} from '../lib/emailKindCatalogue';
import {
  extractVariables,
  isRenderableTemplate,
  type EmailTemplateShape,
} from '../lib/emailVariableEngine';

/** The engine's token grammar, mirrored here so the test catches a variable
 *  the catalogue uses but never declares. */
const VARIABLE_TOKEN = /\{\{\s*([a-zA-Z0-9_.\-]*?)\s*\}\}/g;

function tokensIn(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(VARIABLE_TOKEN)) {
    names.push(match[1]);
  }
  return names;
}

/** Every templated text field of a definition's default template. */
function templateTexts(definition: EmailKindDefinition): string[] {
  return shapeTexts(definition.defaultTemplate);
}

/** Every templated text field of ANY template shape - the ordinary copy or the
 *  bundled one. Subject, preheader, heading, every block and the footer note:
 *  a token hiding in a field this misses is a token nothing would substitute. */
function shapeTexts(shape: EmailTemplateShape): string[] {
  const defaultTemplate = shape;
  const texts: string[] = [defaultTemplate.subject, defaultTemplate.heading];
  if (defaultTemplate.preheader !== undefined) {
    texts.push(defaultTemplate.preheader);
  }
  if (defaultTemplate.footerNote !== undefined) {
    texts.push(defaultTemplate.footerNote);
  }
  for (const block of defaultTemplate.blocks) {
    if (block.type === 'paragraph') {
      texts.push(block.text);
    } else if (block.type === 'detail-rows') {
      for (const row of block.rows ?? []) {
        texts.push(row.label, row.value);
      }
    } else {
      texts.push(block.label);
      if (block.href !== undefined) {
        texts.push(block.href);
      }
    }
  }
  return texts;
}

function isWellFormedBlock(block: EmailTemplateBlock): boolean {
  if (typeof block.id !== 'string' || block.id === '') {
    return false;
  }
  switch (block.type) {
    case 'paragraph':
      return typeof block.text === 'string' && block.text !== '';
    case 'detail-rows':
      if (block.source !== 'custom' && block.source !== 'kind') {
        return false;
      }
      // A custom rows block with nothing in it renders an empty card.
      if (block.source === 'custom' && (block.rows ?? []).length === 0) {
        return false;
      }
      return (block.rows ?? []).every(
        (row) =>
          typeof row.id === 'string' &&
          row.id !== '' &&
          typeof row.label === 'string' &&
          row.label !== '' &&
          typeof row.value === 'string' &&
          row.value !== '',
      );
    case 'cta':
      if (typeof block.label !== 'string' || block.label === '') {
        return false;
      }
      // A CTA must know where it points: an authored URL or the kind link.
      return block.useKindLink === true || typeof block.href === 'string';
    default:
      return false;
  }
}

describe('emailKindCatalogue', () => {
  const definitions = Object.values(EMAIL_KINDS);

  it('covers exactly the EMAIL_KIND_IDS vocabulary', () => {
    expect(Object.keys(EMAIL_KINDS).sort()).toEqual([...EMAIL_KIND_IDS].sort());
  });

  it('keys every definition under its own id', () => {
    for (const [id, definition] of Object.entries(EMAIL_KINDS)) {
      expect(definition.id).toBe(id);
    }
  });

  it('gives every kind a non-empty label, description and category', () => {
    for (const definition of definitions) {
      expect(definition.label).not.toBe('');
      expect(definition.description).not.toBe('');
      expect(definition.category).not.toBe('');
    }
  });

  it('gives every default template a non-empty subject and heading and well-formed blocks', () => {
    for (const definition of definitions) {
      expect(definition.defaultTemplate.subject).not.toBe('');
      expect(definition.defaultTemplate.heading).not.toBe('');
      expect(definition.defaultTemplate.blocks.length).toBeGreaterThan(0);
      for (const block of definition.defaultTemplate.blocks) {
        expect(isWellFormedBlock(block)).toBe(true);
      }
    }
  });

  it('keeps block ids unique within each template', () => {
    for (const definition of definitions) {
      const ids = definition.defaultTemplate.blocks.map((block) => block.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('declares every variable its default template uses, with unique names, labels and examples', () => {
    for (const definition of definitions) {
      const names = definition.variables.map((variable) => variable.name);
      expect(new Set(names).size).toBe(names.length);
      for (const variable of definition.variables) {
        expect(variable.name).not.toBe('');
        expect(variable.label).not.toBe('');
        expect(variable.example).not.toBe('');
      }
      const declared = new Set(names);
      for (const text of templateTexts(definition)) {
        for (const token of tokensIn(text)) {
          if (!declared.has(token)) {
            throw new Error(
              `${definition.id}: template uses undeclared variable '${token}'`,
            );
          }
        }
      }
    }
  });

  it('forbids toggling only the security- and billing-critical kinds', () => {
    // 'invitation' (a security email) and 'manual' (no toggle to speak of),
    // plus the two billing kinds whose silence would let an organisation
    // discover a suspension by surprise: 'payment-failed' is the only warning
    // before access pauses, and 'subscription-ended' reports that it has.
    const nonToggleable: EmailKindId[] = [
      'invitation',
      'manual',
      'payment-failed',
      'subscription-ended',
    ];
    for (const definition of definitions) {
      expect(definition.toggleAllowed).toBe(
        !nonToggleable.includes(definition.id),
      );
    }
  });

  it('backs every hasKindRows claim with exactly one kind-sourced detail-rows block, and no kind-sourced block without one', () => {
    for (const definition of definitions) {
      const kindRowBlocks = definition.defaultTemplate.blocks.filter(
        (block) => block.type === 'detail-rows' && block.source === 'kind',
      );
      expect(kindRowBlocks.length).toBe(definition.hasKindRows ? 1 : 0);
    }
  });

  it('uses the kind link (never an authored URL) whenever a template carries a CTA', () => {
    for (const definition of definitions) {
      for (const block of definition.defaultTemplate.blocks) {
        if (block.type === 'cta') {
          expect(definition.hasKindLink).toBe(true);
          expect(block.useKindLink).toBe(true);
        }
      }
    }
  });

  it('lists every kind except manual as configurable, in catalogue order', () => {
    expect(CONFIGURABLE_EMAIL_KIND_IDS).toEqual(
      (Object.keys(EMAIL_KINDS) as EmailKindId[]).filter(
        (id) => id !== 'manual',
      ),
    );
  });

  it('emailKind() returns the catalogue entry', () => {
    expect(emailKind('invitation')).toBe(EMAIL_KINDS.invitation);
  });

  // Spot checks: three kinds' copy verbatim against their send sites.
  it('keeps the invitation copy verbatim (lib/invitations.ts issueInvitation)', () => {
    const { defaultTemplate } = EMAIL_KINDS.invitation;
    expect(defaultTemplate.subject).toBe('You have been invited to Safentia');
    expect(defaultTemplate.preheader).toBe(
      'Accept your invitation to join your organisation on Safentia.',
    );
    const first = defaultTemplate.blocks[0];
    expect(first.type).toBe('paragraph');
    expect(first.type === 'paragraph' && first.text).toBe(
      'Your organisation has invited you to join it on Safentia, the fire risk assessment platform.',
    );
  });

  it('keeps the released-contact CTA label verbatim (functions/onAssessmentStageChange.ts)', () => {
    const cta = EMAIL_KINDS['released-contact'].defaultTemplate.blocks.find(
      (block) => block.type === 'cta',
    );
    expect(cta?.type === 'cta' && cta.label).toBe('Accept & Sign Off');
  });

  it('keeps the contract-ended copy verbatim (functions/customerContracts.ts)', () => {
    const { defaultTemplate } = EMAIL_KINDS['contract-ended'];
    expect(defaultTemplate.subject).toBe('Contract ended: {{customer.name}}');
    expect(defaultTemplate.heading).toBe(
      '{{org.name}}: a customer contract has ended',
    );
  });

  it('pins the billing kinds contract (functions/stripeWebhook.ts sends)', () => {
    // All three are org-member billing kinds the webhook fans out to admins.
    for (const id of [
      'payment-failed',
      'payment-receipt',
      'subscription-ended',
    ] as const) {
      expect(EMAIL_KINDS[id].category).toBe('billing');
      expect(EMAIL_KINDS[id].audience).toBe('org-member');
      expect(EMAIL_KINDS[id].hasKindLink).toBe(true);
    }
    expect(EMAIL_KINDS['payment-receipt'].defaultTemplate.subject).toBe(
      'Receipt: {{invoice.amountFormatted}} — {{org.name}}',
    );
    expect(EMAIL_KINDS['payment-failed'].defaultTemplate.subject).toBe(
      'Payment failed for {{org.name}}',
    );
  });
});

// ============================================================================
// Delivery policy and the bundled copy (EMAIL_BUNDLING_PLAN.md §3, §4.4).
//
// The catalogue is where "at most one email per (recipient, kind) per UK day"
// is actually DECLARED: lib/emailDigest only obeys what it reads here. Two
// declarations have to hold together, and neither is checkable by the type
// system, so they are pinned here instead.
//
//  1. Exactly the six named kinds are 'immediate', and exactly those six lack
//     a `digest` block. A missing block on a bundled kind is not a cosmetic
//     gap: emailDigest treats "no digest block" as "cannot be bundled" and
//     sends every one of that kind immediately, silently undoing the feature
//     for it. A block on an immediate kind is dead copy that can rot.
//
//  2. A digest template may reference ONLY the four variables the flush
//     actually supplies - digest.count, digest.countPhrase, digest.moreNote
//     and org.name. A digest spans many buildings and many events, so there is
//     no {{building.name}} to be had; any other token would substitute to the
//     empty string and ship a sentence with a hole in it. The rows and the
//     link come from the flush too, which is why every digest template must
//     carry a kind-sourced detail-rows block and a useKindLink cta, and why
//     the moreNote paragraph must be omitIfEmpty - on a bundle that lost
//     nothing, moreNote is '' and an un-omitted paragraph renders blank.
// ============================================================================
describe('emailKindCatalogue - delivery policy and digest copy', () => {
  const definitions = Object.values(EMAIL_KINDS);

  /** The six kinds that may never be held. Security and access-critical mail,
   *  the admin-composed send, and the two kinds that are ALREADY one per
   *  recipient per day by construction. */
  const IMMEDIATE_KIND_IDS: EmailKindId[] = [
    'invitation',
    'payment-failed',
    'subscription-ended',
    'manual',
    'job-reminder',
    'deadline-admin-digest',
  ];

  /** Everything the flush puts on a digest render, and nothing else. */
  const DIGEST_VARIABLES = [
    'digest.count',
    'digest.countPhrase',
    'digest.moreNote',
    'org.name',
  ];

  it('gives every kind a delivery policy from the declared vocabulary', () => {
    for (const definition of definitions) {
      expect(EMAIL_DELIVERY_POLICIES).toContain(definition.delivery);
    }
  });

  it('marks exactly the six un-bundlable kinds immediate', () => {
    const immediate = definitions
      .filter((definition) => definition.delivery === 'immediate')
      .map((definition) => definition.id);
    expect(immediate.sort()).toEqual([...IMMEDIATE_KIND_IDS].sort());
  });

  it('gives a digest block to every kind EXCEPT those six, and to none of them', () => {
    for (const definition of definitions) {
      const shouldBundle = !IMMEDIATE_KIND_IDS.includes(definition.id);
      expect(definition.digest !== undefined).toBe(shouldBundle);
      // The two statements are the same statement: a kind emailDigest may
      // bundle is exactly a kind that is not immediate.
      expect(definition.delivery !== 'immediate').toBe(shouldBundle);
    }
  });

  it('makes every digest template renderable by the one renderer', () => {
    for (const definition of definitions) {
      if (definition.digest === undefined) continue;
      expect(isRenderableTemplate(definition.digest.defaultTemplate)).toBe(true);
      for (const block of definition.digest.defaultTemplate.blocks) {
        expect(isWellFormedBlock(block)).toBe(true);
      }
      const ids = definition.digest.defaultTemplate.blocks.map((block) => block.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('references ONLY the four variables the flush supplies, in every digest field', () => {
    for (const definition of definitions) {
      if (definition.digest === undefined) continue;
      for (const text of shapeTexts(definition.digest.defaultTemplate)) {
        for (const token of extractVariables(text)) {
          if (!DIGEST_VARIABLES.includes(token)) {
            throw new Error(
              `${definition.id}: digest template uses '${token}', which the flush does not supply`,
            );
          }
        }
      }
    }
  });

  it('carries a kind-sourced detail-rows block in every digest template - the flush supplies the rows', () => {
    for (const definition of definitions) {
      if (definition.digest === undefined) continue;
      const rowBlocks = definition.digest.defaultTemplate.blocks.filter(
        (block) => block.type === 'detail-rows' && block.source === 'kind',
      );
      expect(rowBlocks).toHaveLength(1);
    }
  });

  it('points every digest CTA at the kind link, never an authored URL - the flush supplies it', () => {
    for (const definition of definitions) {
      if (definition.digest === undefined) continue;
      const ctas = definition.digest.defaultTemplate.blocks.filter(
        (block) => block.type === 'cta',
      );
      expect(ctas).toHaveLength(1);
      const cta = ctas[0];
      expect(cta.type === 'cta' && cta.useKindLink).toBe(true);
      expect(cta.type === 'cta' && cta.href).toBeUndefined();
    }
  });

  it('omits the moreNote paragraph when nothing overflowed', () => {
    for (const definition of definitions) {
      if (definition.digest === undefined) continue;
      const moreNotes = definition.digest.defaultTemplate.blocks.filter(
        (block) =>
          block.type === 'paragraph' &&
          extractVariables(block.text).includes('digest.moreNote'),
      );
      // Exactly one paragraph carries the overflow line...
      expect(moreNotes).toHaveLength(1);
      const moreNote = moreNotes[0];
      // ...and it drops entirely when the bundle lost nothing, rather than
      // rendering an empty paragraph into the middle of the email.
      expect(moreNote.type === 'paragraph' && moreNote.omitIfEmpty).toBe(true);
    }
  });

  it('gives every digest a singular/plural noun pair and a console-relative CTA path', () => {
    for (const definition of definitions) {
      if (definition.digest === undefined) continue;
      const { noun, ctaPath } = definition.digest;
      expect(noun).toHaveLength(2);
      const [singular, plural] = noun;
      expect(typeof singular).toBe('string');
      expect(typeof plural).toBe('string');
      expect(singular).not.toBe('');
      expect(plural).not.toBe('');
      // A path, not a URL: the flush prefixes WEB_ORIGIN, and the catalogue is
      // a pure mirrored module that must not import it.
      expect(ctaPath.startsWith('/')).toBe(true);
      expect(ctaPath).not.toMatch(/^https?:/);
    }
  });

  it('gives every digest a non-empty subject and heading', () => {
    for (const definition of definitions) {
      if (definition.digest === undefined) continue;
      expect(definition.digest.defaultTemplate.subject).not.toBe('');
      expect(definition.digest.defaultTemplate.heading).not.toBe('');
      expect(definition.digest.defaultTemplate.blocks.length).toBeGreaterThan(0);
    }
  });
});
