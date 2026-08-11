// ============================================================================
// templatedEmail seam - loadKindConfig + sendKindEmail behaviour.
//
// The seam's whole contract is "a business send must never fail over
// configuration", so these tests pin every degradation path: disabled kinds
// suppress silently, untoggleable kinds ignore a hostile enabled:false,
// missing/junk assigned templates fall back to the built-in default, unknown
// variables warn without withholding the email, and an unreadable RTDB still
// sends. The dispatch seam and firebase-admin are both mocked so the suite
// stays a pure unit test (the admin module is only ever lazily imported by
// the code under test, which is exactly why the mock factory works).
// ============================================================================

import { forEnv } from '../shared/paths';
import { EMAIL_KINDS } from '../lib/emailKindCatalogue';
import type { EmailTemplateShape } from '../lib/emailVariableEngine';
import type { Logger } from '../lib/logging';
import { dispatchEmail } from '../lib/email';
import { loadKindConfig, sendKindEmail } from '../lib/templatedEmail';
import type { KindSendRequest } from '../lib/templatedEmail';

jest.mock('../lib/email', () => ({
  dispatchEmail: jest.fn(async () => true),
}));

// Settable fake RTDB: path -> stored value. `mock`-prefixed so jest permits
// the factory to close over them (jest.mock factories are hoisted).
const mockDbData: Record<string, unknown> = {};
let mockDbFail = false;

jest.mock('../admin', () => ({
  db: {
    ref: (path: string) => ({
      get: async () => {
        if (mockDbFail) throw new Error('RTDB unavailable');
        return { val: () => (path in mockDbData ? mockDbData[path] : null) };
      },
    }),
  },
}));

const mockDispatch = dispatchEmail as jest.Mock;

const makeLogger = (): Logger => {
  const logger: Logger = {
    correlationId: 'test-correlation',
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: () => logger,
  };
  return logger;
};

const ENV = 'test' as const;
const ORG = 'org-1';
const paths = forEnv(ENV).db;

/** A renderable custom template exercising kindLink + kindRows + variables. */
const customTemplate: EmailTemplateShape = {
  subject: 'Visit to {{building.name}}',
  preheader: 'A visit is booked.',
  heading: 'Visit booked for {{building.name}}',
  blocks: [
    { id: 'p1', type: 'paragraph', text: 'Hello {{contact.name}}, a visit is booked.' },
    { id: 'rows', type: 'detail-rows', source: 'kind' },
    { id: 'cta', type: 'cta', label: 'View the visit', useKindLink: true },
  ],
  footerNote: 'Service message from {{org.name}}.',
};

const baseRequest = (kind: KindSendRequest['kind']): KindSendRequest => ({
  kind,
  env: ENV,
  orgId: ORG,
  to: 'contact@example.com',
  variables: {
    'building.name': 'Rose Court',
    'contact.name': 'Jo',
    'org.name': 'Acme Fire Safety Ltd',
  },
  brand: { name: 'Acme Fire Safety Ltd', accent: '#336699' },
});

beforeEach(() => {
  for (const key of Object.keys(mockDbData)) delete mockDbData[key];
  mockDbFail = false;
  mockDispatch.mockClear();
  mockDispatch.mockResolvedValue(true);
});

describe('sendKindEmail - toggle policy', () => {
  test('disabled kind skips dispatch entirely and returns false', async () => {
    mockDbData[paths.emailKindSetting(ORG, 'visit-scheduled')] = { enabled: false };
    const logger = makeLogger();

    const sent = await sendKindEmail(baseRequest('visit-scheduled'), logger);

    expect(sent).toBe(false);
    // No dispatch at all - so no emailLog entry can exist for the suppression.
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('disabled'),
      expect.objectContaining({ kind: 'visit-scheduled' }),
    );
  });

  test('invitation ignores enabled:false (untoggleable security email)', async () => {
    mockDbData[paths.emailKindSetting(ORG, 'invitation')] = { enabled: false };

    const sent = await sendKindEmail(baseRequest('invitation'), makeLogger());

    expect(sent).toBe(true);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });
});

describe('sendKindEmail - template resolution', () => {
  test('assigned renderable template is used and templateId lands in the context', async () => {
    mockDbData[paths.emailKindSetting(ORG, 'visit-scheduled')] = { templateId: 'tpl-1' };
    mockDbData[paths.emailTemplate(ORG, 'tpl-1')] = customTemplate;

    const sent = await sendKindEmail(baseRequest('visit-scheduled'), makeLogger());

    expect(sent).toBe(true);
    const [message, , context] = mockDispatch.mock.calls[0];
    expect(message.subject).toBe('Visit to Rose Court');
    expect(context).toMatchObject({ templateId: 'tpl-1', kindId: 'visit-scheduled' });
  });

  test('missing assigned template falls back to the default and warns', async () => {
    mockDbData[paths.emailKindSetting(ORG, 'visit-scheduled')] = { templateId: 'gone' };
    const logger = makeLogger();

    const sent = await sendKindEmail(baseRequest('visit-scheduled'), logger);

    expect(sent).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('built-in default'),
      expect.objectContaining({ templateId: 'gone' }),
    );
    const [, , context] = mockDispatch.mock.calls[0];
    // Default copy was rendered, so no templateId may be logged.
    expect(context.templateId).toBeUndefined();
  });

  test('junk assigned template (fails isRenderableTemplate) falls back and warns', async () => {
    mockDbData[paths.emailKindSetting(ORG, 'visit-scheduled')] = { templateId: 'junk' };
    mockDbData[paths.emailTemplate(ORG, 'junk')] = { subject: '', blocks: 'nope' };
    const logger = makeLogger();

    const config = await loadKindConfig(ENV, ORG, 'visit-scheduled', logger);

    // brandingAllowed true: no subscription node exists, so the grandfather
    // rule keeps every feature on (Phase 3 §6).
    expect(config).toEqual({
      kind: 'visit-scheduled',
      enabled: true,
      template: null,
      brandingAllowed: true,
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);

    const sent = await sendKindEmail({ ...baseRequest('visit-scheduled'), config }, logger);
    expect(sent).toBe(true);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });
});

describe('sendKindEmail - rendering', () => {
  test('unknown variables warn but the send continues', async () => {
    mockDbData[paths.emailKindSetting(ORG, 'visit-scheduled')] = { templateId: 'tpl-1' };
    mockDbData[paths.emailTemplate(ORG, 'tpl-1')] = {
      ...customTemplate,
      heading: 'Visit to {{no.such.variable}}',
    };
    const logger = makeLogger();

    const sent = await sendKindEmail(baseRequest('visit-scheduled'), logger);

    expect(sent).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('unknown variables'),
      expect.objectContaining({ unknown: ['no.such.variable'] }),
    );
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  test('kindLink and kindRows flow through to the rendered output', async () => {
    mockDbData[paths.emailKindSetting(ORG, 'visit-scheduled')] = { templateId: 'tpl-1' };
    mockDbData[paths.emailTemplate(ORG, 'tpl-1')] = customTemplate;

    await sendKindEmail(
      {
        ...baseRequest('visit-scheduled'),
        kindLink: 'https://safentia.co.uk/app/visits/v1',
        kindRows: [{ label: 'Date', value: '14 August 2026' }],
      },
      makeLogger(),
    );

    const [message] = mockDispatch.mock.calls[0];
    expect(message.body).toContain('Date: 14 August 2026');
    expect(message.body).toContain('View the visit: https://safentia.co.uk/app/visits/v1');
    expect(message.html).toContain('href="https://safentia.co.uk/app/visits/v1"');
    expect(message.html).toContain('14 August 2026');
  });

  test('context carries the catalogue category and the kind id', async () => {
    await sendKindEmail(baseRequest('visit-scheduled'), makeLogger());

    const [, , context] = mockDispatch.mock.calls[0];
    expect(context).toMatchObject({
      orgId: ORG,
      env: ENV,
      category: EMAIL_KINDS['visit-scheduled'].category,
      kindId: 'visit-scheduled',
    });
  });
});

describe('sendKindEmail - degradation', () => {
  test('RTDB read failure degrades to the default template and still sends', async () => {
    mockDbFail = true;
    const logger = makeLogger();

    const sent = await sendKindEmail(baseRequest('visit-scheduled'), logger);

    expect(sent).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('read failed'),
      expect.objectContaining({ kind: 'visit-scheduled' }),
    );
    const [message] = mockDispatch.mock.calls[0];
    // The built-in default copy was rendered despite the outage.
    expect(message.subject).toBe(
      EMAIL_KINDS['visit-scheduled'].defaultTemplate.subject.replace(
        /\{\{\s*building\.name\s*\}\}/g,
        'Rose Court',
      ),
    );
  });
});
