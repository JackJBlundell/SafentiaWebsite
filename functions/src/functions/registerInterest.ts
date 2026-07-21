// ============================================================================
// registerInterest (callable) - the public site's book-a-demonstration form.
//
// The ONE unauthenticated callable: a prospective customer has no account, so
// there is no assertAuth here. What stands in its place:
//   1. App Check - the request still comes from an attested build of the site.
//   2. Rate limiting - keyed by client IP (there is no uid to key by), so a
//      scripted flood from one address is capped like any other abusive caller.
//   3. Strict validation with tight text ceilings, so the form cannot be used
//      to push an unbounded blob into RTDB.
// The lead is written under the platform-global /platform/leads (a lead
// pre-dates any tenant - there is no org or environment to scope it to; rules
// deny all client access) and the sales contact is notified via the email seam
// (a no-op that logs intent until a provider key is configured). The result is
// deliberately opaque ({received: true}): a public endpoint reveals nothing
// about what happened server-side beyond receipt.
// ============================================================================

import { onCall } from "firebase-functions/v2/https";
import { db } from "../admin";
import { callableOptions } from "../lib/callable";
import { createLogger } from "../lib/logging";
import { fail, runCallable } from "../lib/errors";
import { assertAppCheck } from "../lib/guards";
import { paths } from "../lib/paths";
import { assertRateLimit } from "../lib/rateLimit";
import { dispatchEmail, EMAIL_PROVIDER_SECRETS } from "../lib/email";
import { renderBrandedEmail } from "../lib/emailTemplates";
import {
  assertObject,
  optionalString,
  requireEmail,
  requireString,
  TEXT_LIMITS,
} from "../lib/validate";
import type {
  PlatformLead,
  RegisterInterestInput,
  RegisterInterestResult,
} from "../shared/types";

/** Where new leads are announced. TEMPORARY during development: the developer's
 *  own inbox (it must also be the Resend account email while the sender domain
 *  is unverified - sandbox mode only delivers to the account owner). Switch to
 *  the Client's sales contact (see SiteFooter) at handover. */
const LEAD_NOTIFICATION_RECIPIENT = "jackjblundell@gmail.com";

/**
 * Derive the rate-limit bucket key for an unauthenticated caller. The lib keys
 * buckets by uid; a public form has none, so the client IP is the closest
 * per-caller identity available.
 *
 * The IP is taken from the request's X-Forwarded-For header, SECOND FROM THE
 * END, and deliberately not from Express's `req.ip`. Behind Google's front end
 * the header arrives as "<whatever the client sent>, <real client IP>, <GFE>":
 * the front end APPENDS the address it actually saw but does not strip what the
 * client fabricated. `req.ip` (trust-proxy leftmost) would therefore hand the
 * bucket key to the attacker - one spoofed header per request, one fresh bucket
 * per request, no limit at all. The second-from-last entry is the one written by
 * Google's own hop, which the caller cannot influence.
 *
 * RTDB keys cannot contain `. $ # [ ] /`, and an IP is full of dots (or colons),
 * so unsafe characters are mapped to hyphens (still one bucket per address - two
 * addresses never collapse into one key).
 */
export function rateLimitKeyFor(
  forwardedFor: string | string[] | undefined,
  socketAddress: string | undefined
): string {
  const header = Array.isArray(forwardedFor)
    ? forwardedFor.join(",")
    : forwardedFor;
  const hops = (header ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  // hops[length-1] is Google's front end itself; hops[length-2] is the address
  // the front end saw the request arrive from - the real client.
  const ip =
    hops.length >= 2 ? hops[hops.length - 2] : hops[0] ?? socketAddress;
  if (!ip) {
    // No usable address (should not happen behind Google's front end); all such
    // calls share one bucket rather than escaping the limit entirely.
    return "ip-unknown";
  }
  return `ip-${ip.replace(/[^a-zA-Z0-9:-]/g, "-").replace(/:/g, "_")}`;
}

/**
 * Single-line fields are refused if they carry control characters. They are
 * interpolated into the notification email's subject and body: a value such as
 * "Acme\r\nBcc: ..." must die here, at the boundary, not survive until the day
 * the email seam is wired to a provider that honours raw headers.
 */
function assertSingleLine(value: string, field: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw fail.invalidArgument(
      `The ${field} field must not contain line breaks or control characters.`
    );
  }
  return value;
}

export const registerInterest = onCall<RegisterInterestInput>(
  // The email secret must be attached here or the runtime never receives it and
  // dispatchEmail silently stays in its not-configured no-op mode.
  { ...callableOptions, secrets: EMAIL_PROVIDER_SECRETS },
  (request) => {
    const logger = createLogger({ fn: "registerInterest" });
    return runCallable<RegisterInterestResult>(logger, async () => {
      // 1. Attestation only - this is a public form, so no assertAuth. App
      // Check still turns away anything that is not the genuine site build.
      assertAppCheck(request);

      // 2. Abuse control before any validation work: one IP gets a small
      // fixed-window allowance (RATE_LIMITS.registerInterest).
      await assertRateLimit(
        rateLimitKeyFor(
          request.rawRequest.headers["x-forwarded-for"],
          request.rawRequest.socket?.remoteAddress ?? undefined
        ),
        "registerInterest"
      );

      // 3. Validate. Names and organisations are single-line fields; the
      // message is bounded free text. The email is shape-checked so the sales
      // follow-up has something answerable to reply to.
      const input = assertObject(request.data);
      const name = assertSingleLine(
        requireString(input, "name", TEXT_LIMITS.displayName),
        "name"
      );
      const organisation = assertSingleLine(
        requireString(input, "organisation", TEXT_LIMITS.shortText),
        "organisation"
      );
      const email = requireEmail(input);
      const rawPhone = optionalString(input, "phone", TEXT_LIMITS.shortText);
      const phone = rawPhone ? assertSingleLine(rawPhone, "phone") : rawPhone;
      const message = optionalString(input, "message", TEXT_LIMITS.freeText);

      // 4. Store the lead. A push key gives a chronologically-ordered id, and
      // the record is the source of truth: a failed notification email must
      // never lose the enquiry.
      const leadRef = db.ref(paths.platform.leads()).push();
      if (!leadRef.key) {
        throw fail.internal("The enquiry could not be stored.");
      }
      const lead: PlatformLead = {
        name,
        organisation,
        email,
        ...(phone ? { phone } : {}),
        ...(message ? { message } : {}),
        receivedAt: Date.now(),
      };
      await db.ref(paths.platform.lead(leadRef.key)).set(lead);
      logger.info("Lead stored", { leadId: leadRef.key });

      // 5. Notify the sales contact. dispatchEmail never throws on provider
      // problems and no-ops (logging intent) until a provider key exists, so
      // the stored lead remains the operative record either way.
      // No EmailDispatchContext here BY DESIGN: a lead pre-dates any tenant, so
      // there is no orgId to file a per-org emailLog entry under. The stored
      // /platform/leads record is this send's durable trail instead.
      await dispatchEmail(
        {
          to: LEAD_NOTIFICATION_RECIPIENT,
          subject: `New demonstration enquiry from ${organisation}`,
          // Plain-text part: the fallback for text-only clients and filters.
          body: [
            "A new enquiry was submitted on the Safentia website.",
            "",
            `Name: ${name}`,
            `Organisation: ${organisation}`,
            `Email: ${email}`,
            `Phone: ${phone ?? "not provided"}`,
            `Message: ${message ?? "not provided"}`,
            "",
            `Lead id: ${leadRef.key}`,
          ].join("\n"),
          // The branded document. Every field below is user-supplied and is
          // escaped by the template layer. This is an inbound lead notification
          // TO Safentia (the platform), not an email FROM an organisation, so it
          // stays the default Safentia brand - there is no sending org to dress
          // it in.
          html: renderBrandedEmail({
            preheader: `${name}, ${organisation}`,
            heading: "New demonstration enquiry",
            paragraphs: [
              "A visitor has asked to book a demonstration through the Safentia website.",
            ],
            detailRows: [
              { label: "Name", value: name },
              { label: "Organisation", value: organisation },
              { label: "Email", value: email },
              { label: "Phone", value: phone ?? "Not provided" },
              { label: "Message", value: message ?? "Not provided" },
              { label: "Lead reference", value: leadRef.key },
            ],
            cta: {
              label: `Reply to ${name}`,
              url: `mailto:${email}?subject=${encodeURIComponent(
                "Your Safentia demonstration"
              )}`,
            },
            footerNote:
              "You are receiving this because a visitor submitted the contact form on safentia.co.uk. The lead is also stored in the platform, so nothing is lost if this email goes astray.",
          }),
        },
        logger
      );

      return { received: true };
    });
  }
);
