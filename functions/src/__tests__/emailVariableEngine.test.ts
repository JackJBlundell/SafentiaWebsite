// ============================================================================
// emailVariableEngine unit tests.
//
// The variable engine is a pure module, so its whole contract - substitution
// modes, omitIfEmpty, detail-row filtering, cta scheme guarding, plain-text
// assembly and the structural guard - is unit-testable without any callable
// or RTDB harness. These tests pin the behaviour both the console's live
// preview and the Cloud Functions send path depend on, since the file is
// mirrored byte-for-byte between the two trees.
// ============================================================================

import type { EmailTemplateBlock } from '../../types';
import {
  extractVariables,
  isRenderableTemplate,
  renderTemplate,
  substitute,
  type EmailTemplateShape,
} from '../lib/emailVariableEngine';

const paragraph = (text: string, omitIfEmpty?: boolean): EmailTemplateBlock => ({
  id: 'p1',
  type: 'paragraph',
  text,
  ...(omitIfEmpty === undefined ? {} : { omitIfEmpty }),
});

const shape = (blocks: EmailTemplateBlock[], extra?: Partial<EmailTemplateShape>): EmailTemplateShape => ({
  subject: 'Subject',
  heading: 'Heading',
  blocks,
  ...extra,
});

describe('substitute', () => {
  test('replaces known variables', () => {
    const result = substitute('Hello {{name}}, welcome to {{org.name}}.', { name: 'Ana', 'org.name': 'Safentia' }, 'send');
    expect(result.text).toBe('Hello Ana, welcome to Safentia.');
    expect(result.unknown).toEqual([]);
    expect(result.usedEmpty).toEqual([]);
  });

  test('tolerates whitespace inside tokens', () => {
    expect(substitute('Hi {{ org.name }}!', { 'org.name': 'Safentia' }, 'send').text).toBe('Hi Safentia!');
  });

  test('handles adjacent tokens', () => {
    expect(substitute('{{a}}{{b}}', { a: 'x', b: 'y' }, 'send').text).toBe('xy');
  });

  test('send mode blanks unknown variables and reports them', () => {
    const result = substitute('Ref {{job.ref}} at {{site}}', { site: 'Depot' }, 'send');
    expect(result.text).toBe('Ref  at Depot');
    expect(result.unknown).toEqual(['job.ref']);
  });

  test('preview mode leaves unknown tokens literal and still reports them', () => {
    const result = substitute('Ref {{ job.ref }}', {}, 'preview');
    expect(result.text).toBe('Ref {{ job.ref }}');
    expect(result.unknown).toEqual(['job.ref']);
  });

  test('collects known-but-empty variables in usedEmpty, deduped', () => {
    const result = substitute('{{reason}} {{reason}} {{name}}', { reason: '', name: 'Ana' }, 'send');
    expect(result.text).toBe('  Ana');
    expect(result.usedEmpty).toEqual(['reason']);
    expect(result.unknown).toEqual([]);
  });
});

describe('extractVariables', () => {
  test('returns distinct tokens in order of first appearance', () => {
    expect(extractVariables('{{b}} {{ a }} {{b}} {{c.d-e}}')).toEqual(['b', 'a', 'c.d-e']);
  });

  test('returns empty for a static string', () => {
    expect(extractVariables('No tokens here')).toEqual([]);
  });
});

describe('renderTemplate - paragraphs', () => {
  test('omitIfEmpty drops a paragraph whose variables all resolve empty or unknown', () => {
    const rendered = renderTemplate(
      shape([paragraph('Reason: {{reason}} {{missing}}', true)]),
      { reason: '' },
      'send',
    );
    expect(rendered.paragraphs).toEqual([]);
    expect(rendered.unknown).toEqual(['missing']);
  });

  test('omitIfEmpty keeps the paragraph when one variable is non-empty', () => {
    const rendered = renderTemplate(
      shape([paragraph('Reason: {{reason}} ({{code}})', true)]),
      { reason: '', code: 'X1' },
      'send',
    );
    expect(rendered.paragraphs).toEqual(['Reason:  (X1)']);
  });

  test('omitIfEmpty never drops a static paragraph', () => {
    const rendered = renderTemplate(shape([paragraph('Always shown.', true)]), {}, 'send');
    expect(rendered.paragraphs).toEqual(['Always shown.']);
  });

  test('drops paragraphs that substitute to whitespace even without omitIfEmpty', () => {
    const rendered = renderTemplate(shape([paragraph('  {{gone}}  ')]), { gone: '' }, 'send');
    expect(rendered.paragraphs).toEqual([]);
  });
});

describe('renderTemplate - detail rows', () => {
  test('custom rows substitute label and value and drop empty-valued rows', () => {
    const rendered = renderTemplate(
      shape([
        {
          id: 'd1',
          type: 'detail-rows',
          source: 'custom',
          rows: [
            { id: 'r1', label: '{{k}} ref', value: '{{ref}}' },
            { id: 'r2', label: 'Notes', value: '{{notes}}' },
          ],
        },
      ]),
      { k: 'Job', ref: 'J-42', notes: '' },
      'send',
    );
    expect(rendered.detailRows).toEqual([{ label: 'Job ref', value: 'J-42' }]);
  });

  test('kind source splices kindRows verbatim and ignores authored rows', () => {
    const rendered = renderTemplate(
      shape([
        {
          id: 'd1',
          type: 'detail-rows',
          source: 'kind',
          rows: [{ id: 'r1', label: 'Authored', value: 'ignored' }],
        },
      ]),
      {},
      'send',
      [{ label: 'Visit', value: '3 Sep, 10:00' }],
    );
    expect(rendered.detailRows).toEqual([{ label: 'Visit', value: '3 Sep, 10:00' }]);
  });
});

describe('renderTemplate - cta', () => {
  test('substitutes variables into the href', () => {
    const rendered = renderTemplate(
      shape([{ id: 'c1', type: 'cta', label: 'Open {{thing}}', href: 'https://safentia.co.uk/{{path}}' }]),
      { thing: 'report', path: 'app/reports' },
      'send',
    );
    expect(rendered.cta).toEqual({ label: 'Open report', url: 'https://safentia.co.uk/app/reports' });
  });

  test('drops a non-http(s) url in send mode but keeps it in preview', () => {
    const blocks: EmailTemplateBlock[] = [
      { id: 'c1', type: 'cta', label: 'Bad', href: 'javascript:alert(1)' },
    ];
    expect(renderTemplate(shape(blocks), {}, 'send').cta).toBeUndefined();
    expect(renderTemplate(shape(blocks), {}, 'preview').cta).toEqual({
      label: 'Bad',
      url: 'javascript:alert(1)',
    });
  });

  test('useKindLink takes the kind link and ignores any authored href', () => {
    const rendered = renderTemplate(
      shape([{ id: 'c1', type: 'cta', label: 'Go', href: 'https://ignored.example', useKindLink: true }]),
      {},
      'send',
      undefined,
      'https://safentia.co.uk/app/visit/1',
    );
    expect(rendered.cta).toEqual({ label: 'Go', url: 'https://safentia.co.uk/app/visit/1' });
  });

  test('useKindLink without a kindLink drops the cta', () => {
    const rendered = renderTemplate(
      shape([{ id: 'c1', type: 'cta', label: 'Go', useKindLink: true }]),
      {},
      'preview',
    );
    expect(rendered.cta).toBeUndefined();
  });

  test('the first surviving cta of several wins', () => {
    const rendered = renderTemplate(
      shape([
        { id: 'c1', type: 'cta', label: 'Dropped', useKindLink: true },
        { id: 'c2', type: 'cta', label: 'First', href: 'https://a.example' },
        { id: 'c3', type: 'cta', label: 'Second {{x}}', href: 'https://b.example' },
      ]),
      {},
      'send',
    );
    expect(rendered.cta).toEqual({ label: 'First', url: 'https://a.example' });
    // Later ctas are still scanned so the editor hears about their unknowns.
    expect(rendered.unknown).toEqual(['x']);
  });
});

describe('renderTemplate - fields and text body', () => {
  test('strips newlines from the substituted subject', () => {
    const rendered = renderTemplate(
      shape([], { subject: 'Line one {{v}} two' }),
      { v: 'a\nb\r\nc' },
      'send',
    );
    expect(rendered.subject).toBe('Line one a b c two');
  });

  test('joins the plain-text body with blank lines in order', () => {
    const rendered = renderTemplate(
      shape(
        [
          paragraph('Para one.'),
          {
            id: 'd1',
            type: 'detail-rows',
            source: 'custom',
            rows: [
              { id: 'r1', label: 'Ref', value: 'J-42' },
              { id: 'r2', label: 'Site', value: 'Depot' },
            ],
          },
          { id: 'c1', type: 'cta', label: 'Open', href: 'https://safentia.co.uk/app' },
        ],
        { footerNote: 'Footer.' },
      ),
      {},
      'send',
    );
    expect(rendered.text).toBe(
      'Heading\n\nPara one.\n\nRef: J-42\nSite: Depot\n\nOpen: https://safentia.co.uk/app\n\nFooter.',
    );
  });

  test('dedupes unknown variables across fields', () => {
    const rendered = renderTemplate(
      shape([paragraph('{{a}} {{b}}')], { subject: 'S {{a}}', heading: 'H {{a}}' }),
      {},
      'preview',
    );
    expect(rendered.unknown).toEqual(['a', 'b']);
  });
});

describe('isRenderableTemplate', () => {
  test('accepts a minimal valid doc', () => {
    expect(isRenderableTemplate({ subject: 'S', heading: 'H', blocks: [] })).toBe(true);
    expect(
      isRenderableTemplate({
        subject: 'S',
        heading: 'H',
        preheader: 'P',
        footerNote: 'F',
        blocks: [
          { id: 'p1', type: 'paragraph', text: 'Hi', omitIfEmpty: true },
          { id: 'd1', type: 'detail-rows', source: 'kind' },
          { id: 'c1', type: 'cta', label: 'Go', useKindLink: true },
        ],
      }),
    ).toBe(true);
  });

  test('rejects non-objects and null', () => {
    expect(isRenderableTemplate(null)).toBe(false);
    expect(isRenderableTemplate('template')).toBe(false);
    expect(isRenderableTemplate(42)).toBe(false);
    expect(isRenderableTemplate([])).toBe(false);
  });

  test('rejects a missing or blank heading', () => {
    expect(isRenderableTemplate({ subject: 'S', blocks: [] })).toBe(false);
    expect(isRenderableTemplate({ subject: 'S', heading: '   ', blocks: [] })).toBe(false);
  });

  test('rejects an unknown block type', () => {
    expect(
      isRenderableTemplate({
        subject: 'S',
        heading: 'H',
        blocks: [{ id: 'x1', type: 'image', src: 'x' }],
      }),
    ).toBe(false);
  });

  test('rejects a paragraph with non-string text', () => {
    expect(
      isRenderableTemplate({
        subject: 'S',
        heading: 'H',
        blocks: [{ id: 'p1', type: 'paragraph', text: 7 }],
      }),
    ).toBe(false);
  });
});
