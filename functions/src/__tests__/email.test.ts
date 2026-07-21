// ============================================================================
// dispatchEmail integration behaviour (finding 2064 AC4).
//
// Proves the two contractual modes of the email seam without any network:
//   1. NOT CONFIGURED - no provider key in the environment: the send no-ops
//      cleanly (returns false, never touches fetch) and logs the intent with
//      the recipient REDACTED (only hasRecipient, per the PII discipline).
//   2. CONFIGURED - the Resend endpoint is called once with the bearer key,
//      the recipient, the subject, and BOTH parts: text (always) and html
//      (when provided). Provider rejection and network failure both resolve
//      to false - dispatchEmail never throws into the caller, because the
//      business record (invitation / lead) must survive a mail outage.
//
// registerInterest's template selection (renderBrandedEmail wiring) is NOT
// covered here: it is an onCall v2 handler whose closure needs App Check,
// rate-limit and RTDB seams - a full callable harness - so exercising it from
// jest without the emulator would mock away exactly what it should prove.
// Its email CONTENT path is plain data assembly into dispatchEmail, whose
// contract is what these tests pin down.
// ============================================================================

import { dispatchEmail, isEmailConfigured, type EmailMessage } from '../lib/email';
import type { Logger } from '../lib/logging';

/** A logger whose four channels are inspectable jest fns. */
function stubLogger() {
  const logger = {
    correlationId: 'test',
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
  };
  logger.child.mockReturnValue(logger as unknown as Logger);
  return logger as unknown as Logger & {
    info: jest.Mock;
    error: jest.Mock;
  };
}

const MESSAGE: EmailMessage = {
  to: 'recipient@example.com',
  subject: 'Your Safentia invitation',
  body: 'Plain-text part',
  html: '<p>Branded part</p>',
};

const ORIGINAL_KEY = process.env.EMAIL_PROVIDER_API_KEY;
const ORIGINAL_FETCH = global.fetch;

let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_KEY === undefined) {
    delete process.env.EMAIL_PROVIDER_API_KEY;
  } else {
    process.env.EMAIL_PROVIDER_API_KEY = ORIGINAL_KEY;
  }
});

describe('dispatchEmail - provider not configured', () => {
  beforeEach(() => {
    delete process.env.EMAIL_PROVIDER_API_KEY;
  });

  test('reports not-configured', () => {
    expect(isEmailConfigured()).toBe(false);
  });

  test('no-ops cleanly: returns false, never calls fetch, logs redacted intent', async () => {
    const logger = stubLogger();
    const sent = await dispatchEmail(MESSAGE, logger);

    expect(sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    // The intent log carries the subject and only a BOOLEAN about the recipient
    // (address redacted - no PII in logs).
    expect(logger.info).toHaveBeenCalledWith(
      'Email provider not configured; skipping send',
      expect.objectContaining({ subject: MESSAGE.subject, hasRecipient: true }),
    );
    const loggedContext = logger.info.mock.calls[0][1] as Record<string, unknown>;
    expect(JSON.stringify(loggedContext)).not.toContain(MESSAGE.to);
  });
});

describe('dispatchEmail - provider configured', () => {
  beforeEach(() => {
    process.env.EMAIL_PROVIDER_API_KEY = 'test-resend-key';
  });

  test('POSTs the Resend endpoint with recipient, subject and both parts', async () => {
    fetchMock.mockResolvedValue({ ok: true } as Response);
    const logger = stubLogger();

    const sent = await dispatchEmail(MESSAGE, logger);

    expect(sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer test-resend-key',
    );
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );

    const payload = JSON.parse(init.body as string);
    expect(payload.to).toEqual([MESSAGE.to]);
    expect(payload.subject).toBe(MESSAGE.subject);
    expect(payload.text).toBe(MESSAGE.body); // plain-text part always present
    expect(payload.html).toBe(MESSAGE.html); // branded part when provided
    expect(typeof payload.from).toBe('string');
  });

  test('omits the html key entirely for a text-only message', async () => {
    fetchMock.mockResolvedValue({ ok: true } as Response);
    const { html: _unused, ...textOnly } = MESSAGE;

    await dispatchEmail(textOnly, stubLogger());

    const payload = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect('html' in payload).toBe(false);
    expect(payload.text).toBe(MESSAGE.body);
  });

  test('a provider rejection resolves to false (never throws)', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      text: () => Promise.resolve('invalid sender'),
    } as unknown as Response);
    const logger = stubLogger();

    await expect(dispatchEmail(MESSAGE, logger)).resolves.toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      'Email provider rejected the send',
      expect.objectContaining({ status: 422, subject: MESSAGE.subject }),
    );
  });

  test('an unreachable provider resolves to false (never throws)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    const logger = stubLogger();

    await expect(dispatchEmail(MESSAGE, logger)).resolves.toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      'Email provider unreachable',
      expect.objectContaining({ subject: MESSAGE.subject }),
    );
  });
});
