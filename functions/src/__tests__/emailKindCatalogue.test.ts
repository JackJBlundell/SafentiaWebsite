// ============================================================================
// emailKindCatalogue tests - structural guarantees over the copy-sensitive
// catalogue: the kind set matches the schema vocabulary, every default
// template is well-formed and renderable, every {{variable}} a template uses
// is declared, the toggle policy holds, kind-rows claims are backed by a
// kind-sourced block, and a handful of subjects/labels are spot-checked
// verbatim against the send sites they were extracted from.
// ============================================================================

import { EMAIL_KIND_IDS } from '../shared/types';
import type { EmailKindId, EmailTemplateBlock } from '../shared/types';
import {
  CONFIGURABLE_EMAIL_KIND_IDS,
  EMAIL_KINDS,
  emailKind,
  type EmailKindDefinition,
} from '../lib/emailKindCatalogue';

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
  const { defaultTemplate } = definition;
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
