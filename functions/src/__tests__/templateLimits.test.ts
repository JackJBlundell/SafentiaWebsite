// ============================================================================
// Assessment-template limit - Phase 3 billing §6 (publishTemplate's gate).
//
// Pins the two decisions the callable composes: what COUNTS against the
// ceiling (non-archived live templates only) and what constitutes a NEW
// template (no live node yet - a republish of an existing id is an edit and
// is never metered, §6.3 block-new-creates only). Pure module, no mocks.
// ============================================================================

import {
  assertWithinTemplateLimit,
  countBillableTemplates,
  isNewTemplatePublish,
} from '../lib/templateLimits';
import { SafentiaFunctionError } from '../lib/errors';
import type { Template } from '../shared/types';

const template = (status: Template['status']): Template => ({
  name: 'FRA',
  version: 1,
  status,
  sections: [],
});

describe('isNewTemplatePublish', () => {
  it('treats a missing live node as a new template (metered)', () => {
    expect(isNewTemplatePublish(null)).toBe(true);
  });

  it('treats a republish of an existing id as an edit (never metered)', () => {
    expect(isNewTemplatePublish(template('published'))).toBe(false);
    // Even an archived live node is an existing template, not a new one.
    expect(isNewTemplatePublish(template('archived'))).toBe(false);
  });
});

describe('countBillableTemplates', () => {
  it('counts nothing for an org with no templates node', () => {
    expect(countBillableTemplates(null)).toBe(0);
    expect(countBillableTemplates(undefined)).toBe(0);
  });

  it('counts non-archived templates only - archiving releases the slot', () => {
    expect(
      countBillableTemplates({
        a: template('published'),
        b: template('archived'),
        c: template('published'),
        d: template('draft'),
      }),
    ).toBe(3);
  });
});

describe('assertWithinTemplateLimit', () => {
  it('allows any count when no limit is configured (unlimited mode)', () => {
    expect(() =>
      assertWithinTemplateLimit({ currentTemplateCount: 50, templateLimit: undefined }),
    ).not.toThrow();
  });

  it('allows a new template strictly within the limit', () => {
    expect(() =>
      assertWithinTemplateLimit({ currentTemplateCount: 2, templateLimit: 3 }),
    ).not.toThrow();
  });

  it('refuses at the limit with resource-exhausted naming the plan and ceiling', () => {
    try {
      assertWithinTemplateLimit({
        currentTemplateCount: 3,
        templateLimit: 3,
        planName: 'Silver',
      });
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(SafentiaFunctionError);
      const failure = error as SafentiaFunctionError;
      expect(failure.code).toBe('resource-exhausted');
      expect(failure.message).toContain('Silver');
      expect(failure.message).toContain('3');
    }
  });

  it('never admits a create on the suspended zero floor', () => {
    expect(() =>
      assertWithinTemplateLimit({ currentTemplateCount: 0, templateLimit: 0 }),
    ).toThrow(SafentiaFunctionError);
  });
});
