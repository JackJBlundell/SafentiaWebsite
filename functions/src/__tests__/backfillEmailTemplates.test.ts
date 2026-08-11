// ============================================================================
// backfillEmailTemplates tests - the pure planning half of the seeding script.
// A fresh org receives one template per configurable kind plus the
// Announcement; an org already holding some seed names (case-sensitive match
// on `name`) receives only the missing ones; and every planned doc is a
// complete EmailTemplate - no undefined values anywhere (RTDB rejects them)
// and renderable under the same guard the send path trusts.
// ============================================================================

// The script module imports ../admin for its I/O half; the planning half under
// test is pure, so admin is mocked away entirely (the usageCounters pattern).
jest.mock('../admin', () => ({ db: {} }));

import {
  ANNOUNCEMENT_NAME,
  planOrgTemplates,
} from '../scripts/backfillEmailTemplates';
import {
  CONFIGURABLE_EMAIL_KIND_IDS,
  EMAIL_KINDS,
} from '../lib/emailKindCatalogue';
import { isRenderableTemplate } from '../lib/emailVariableEngine';
import type { EmailTemplate, Keyed } from '../shared/types';

const NOW = 1_700_000_000_000;

/** Every value in the tree must be defined - RTDB rejects undefined. */
function assertNoUndefined(value: unknown, path: string): void {
  expect(value).not.toBeUndefined();
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoUndefined(item, `${path}[${i}]`));
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      assertNoUndefined(child, `${path}.${key}`);
    }
  }
}

/** A minimal stored template with the given name, as the idempotency check
 *  only reads `name`. */
function storedTemplate(name: string): EmailTemplate {
  return {
    name,
    subject: 'Existing subject',
    heading: 'Existing heading',
    blocks: [{ id: 'p1', type: 'paragraph', text: 'Existing body.' }],
    updatedAt: 1,
    updatedBy: 'someone',
  };
}

describe('planOrgTemplates', () => {
  const expectedNames = [
    ...CONFIGURABLE_EMAIL_KIND_IDS.map((id) => EMAIL_KINDS[id].label),
    ANNOUNCEMENT_NAME,
  ];

  it('seeds a fresh org with one template per non-manual kind plus Announcement', () => {
    const plan = planOrgTemplates(null, NOW);
    expect(plan.present).toEqual([]);
    expect(plan.create.map((doc) => doc.name)).toEqual(expectedNames);
    // 'manual' is excluded, so its label never appears as a seed name.
    expect(plan.create.map((doc) => doc.name)).not.toContain(
      EMAIL_KINDS.manual.label,
    );
  });

  it('creates only the missing templates when some names are already present', () => {
    const existing: Keyed<EmailTemplate> = {
      a1: storedTemplate('Invitation'),
      a2: storedTemplate(ANNOUNCEMENT_NAME),
      // Different case is NOT a match - the key is case-sensitive exact.
      a3: storedTemplate('daily job digest (assessors)'),
    };
    const plan = planOrgTemplates(existing, NOW);
    expect(plan.present).toEqual(['Invitation', ANNOUNCEMENT_NAME]);
    const createdNames = plan.create.map((doc) => doc.name);
    expect(createdNames).not.toContain('Invitation');
    expect(createdNames).not.toContain(ANNOUNCEMENT_NAME);
    expect(createdNames).toContain('Daily job digest (assessors)');
    expect(plan.create).toHaveLength(expectedNames.length - 2);
  });

  it('is idempotent - a fully seeded org gets nothing more', () => {
    const first = planOrgTemplates(null, NOW);
    const existing: Keyed<EmailTemplate> = {};
    first.create.forEach((doc, i) => {
      existing[`key${i}`] = doc;
    });
    const second = planOrgTemplates(existing, NOW);
    expect(second.create).toEqual([]);
    expect(second.present).toEqual(expectedNames);
  });

  it('plans complete, renderable docs with no undefined values', () => {
    const plan = planOrgTemplates(null, NOW);
    for (const doc of plan.create) {
      assertNoUndefined(doc, doc.name);
      // The optional keys are omitted entirely when absent, never undefined.
      for (const key of ['preheader', 'footerNote'] as const) {
        if (!(key in doc)) continue;
        expect(typeof doc[key]).toBe('string');
      }
      expect(doc.updatedAt).toBe(NOW);
      expect(doc.updatedBy).toBe('system');
      expect(isRenderableTemplate(doc)).toBe(true);
    }
  });

  it('copies each kind seed from the catalogue default verbatim', () => {
    const plan = planOrgTemplates(null, NOW);
    for (const id of CONFIGURABLE_EMAIL_KIND_IDS) {
      const kind = EMAIL_KINDS[id];
      const doc = plan.create.find((d) => d.name === kind.label);
      expect(doc).toBeDefined();
      expect(doc?.subject).toBe(kind.defaultTemplate.subject);
      expect(doc?.heading).toBe(kind.defaultTemplate.heading);
      expect(doc?.blocks).toEqual(kind.defaultTemplate.blocks);
      expect(doc?.footerNote).toBe(kind.defaultTemplate.footerNote);
    }
  });
});
