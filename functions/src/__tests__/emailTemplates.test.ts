// ============================================================================
// renderBrandedEmail CTA rendering.
//
// The template is a pure function, so its call-to-action wiring is unit-testable
// without any callable or RTDB harness. This pins the one property the
// released-customer email (onAssessmentStageChange) and the invitation email
// (invitations.ts) both depend on: the CTA url is carried through into the HTML
// button, escaped at the boundary. It stands in for asserting the portal link
// reaches the customer, since the trigger's own closure needs the full emulator.
// ============================================================================

import { renderBrandedEmail } from '../lib/emailTemplates';

describe('renderBrandedEmail - CTA', () => {
  test('carries the CTA label and url through into the HTML', () => {
    const html = renderBrandedEmail({
      heading: 'Assessment released',
      paragraphs: ['Your report is available.'],
      cta: { label: 'View your report in the portal', url: 'https://safentia.co.uk/app' },
      footerNote: 'You are the primary contact.',
    });

    // The portal CTA the released-customer email passes lands as a real link.
    expect(html).toContain('href="https://safentia.co.uk/app"');
    expect(html).toContain('View your report in the portal');
  });

  test('escapes the CTA url at the boundary (no raw ampersands)', () => {
    const html = renderBrandedEmail({
      heading: 'You have been invited',
      paragraphs: ['Accept below.'],
      cta: { label: 'Accept', url: 'https://safentia.co.uk/invite?token=a&env=live' },
      footerNote: 'An administrator invited you.',
    });

    expect(html).toContain('href="https://safentia.co.uk/invite?token=a&amp;env=live"');
    expect(html).not.toContain('token=a&env=live');
  });

  test('omits the button entirely when no CTA is given', () => {
    const html = renderBrandedEmail({
      heading: 'No action needed',
      paragraphs: ['Just so you know.'],
      footerNote: 'A courtesy note.',
    });

    expect(html).not.toContain('display:inline-block');
  });
});
