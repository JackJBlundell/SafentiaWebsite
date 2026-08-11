// ============================================================================
// Email dispatch seam (brief 4.5 #2) - now wired to Resend.
//
// Invitations, lead notifications and (later) reports are emailed to recipients
// through Resend's HTTP API, called with the runtime's native fetch - no SDK
// dependency for one POST endpoint. When no provider key is configured the
// module logs the intent (recipient redacted - no PII, brief 18.4) and returns
// successfully, so the security-critical business record is still created and
// usable. That no-op mode is what dev and CI run in.
//
// Wiring requirements (see SETUP.md):
//   1. The secret:  firebase functions:secrets:set EMAIL_PROVIDER_API_KEY
//   2. Attachment:  every Function that sends email must list
//      EMAIL_PROVIDER_SECRETS in its options, or the secret is not mounted into
//      its environment and isEmailConfigured() stays false.
//   3. The sender:  FROM_ADDRESS below. Until safentia.com is verified in
//      Resend (Domains > Add domain > DNS records), Resend only permits its
//      sandbox sender, and only to the account owner's own address.
// ============================================================================

import { defineSecret } from 'firebase-functions/params';
import { forEnv } from '../shared/paths';
import type { EmailLogEntry, Environment } from '../shared/types';
import type { Logger } from './logging';

/**
 * The Resend API key. Declared here, attached per-Function: a v2 Function only
 * receives the env var if the secret appears in its own `secrets` option, so the
 * seam exports the ready-made list for senders to spread in.
 */
export const EMAIL_PROVIDER_API_KEY = defineSecret('EMAIL_PROVIDER_API_KEY');
export const EMAIL_PROVIDER_SECRETS = [EMAIL_PROVIDER_API_KEY];

/**
 * The sender identity. Resend's sandbox sender works out of the box but only
 * delivers to the Resend account owner's email; after the domain is verified,
 * switch to 'Safentia <notifications@safentia.com>' - a one-line change
 * here, as promised in FUTURE_WORK.md section 1.
 */
// Deploy-configurable so the switch to the verified domain is an env var, not
// a code change: set EMAIL_FROM_ADDRESS='Safentia <noreply@safentia.co.uk>'
// once safentia.co.uk is VERIFIED in Resend (Domains -> Add domain -> DNS).
// Until verification, the sandbox default below is the only sender Resend
// accepts - flipping early would fail every send.
const FROM_ADDRESS =
  process.env.EMAIL_FROM_ADDRESS ?? 'Safentia <onboarding@resend.dev>';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * How long we will wait on the provider before abandoning a send.
 *
 * `fetch` has no default timeout, so without this an unresponsive Resend holds
 * the request open until the CALLER's deadline. That is merely slow inside a
 * scheduled sweep, but several senders now dispatch from a CALLABLE's request
 * path AFTER the business mutation has committed (requestInfo, manageAction):
 * there, a hung provider burns the callable's own timeout and the user is shown
 * a hard failure for an act that in fact succeeded, and is likely to retry it.
 * Ten seconds is far beyond a healthy Resend POST and far inside every caller's
 * deadline, so the send is abandoned long before it can take the caller with it.
 */
const SEND_TIMEOUT_MS = 10_000;

/** A message to deliver. `body` is the plain-text part - always present, both
 *  as the fallback for text-only clients and for healthy spam scoring - and
 *  `html` is the branded document from lib/emailTemplates. */
export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
  html?: string;
}

/** True only when the provider secret is configured AND attached to the calling
 *  Function's deployment (both are required for the env var to exist). */
export function isEmailConfigured(): boolean {
  return Boolean(process.env.EMAIL_PROVIDER_API_KEY);
}

/**
 * The business context of a send, for the per-org email log (owner requirement:
 * trackable emails). When `orgId` and `env` are present, every dispatch attempt
 * appends an EmailLogEntry under /{env}/emailLog/{orgId}. Sends with no tenant
 * (e.g. registerInterest leads - a lead pre-dates any organisation) simply pass
 * no context and are logged to the runtime logs only.
 */
export interface EmailDispatchContext {
  orgId?: string;
  env?: Environment;
  /** The send's business category (e.g. 'invitation', 'review-reminder'). */
  category: string;
  /** The EmailKindId that produced the send (templated-email seam). Optional
   *  because pre-templating call sites pass only a category. */
  kindId?: string;
  /** The org template rendered for the send; absent means the built-in
   *  default copy was used. */
  templateId?: string;
}

/**
 * Redact a recipient address for the send log: the first character of the local
 * part plus the full domain (j***@example.com). The log needs enough for an
 * admin to recognise the recipient and no more - storing the full address would
 * duplicate PII into a long-lived log (data minimisation, brief 18.4).
 *
 * Exported (not just used by the log) so sendManualEmail can return the SAME
 * redacted form in its per-recipient results - one redaction rule everywhere.
 */
export function redactRecipient(to: string): string {
  const at = to.indexOf('@');
  if (at <= 0) {
    // Malformed address: reveal nothing beyond the fact there was one.
    return '***';
  }
  return `${to.charAt(0)}***${to.slice(at)}`;
}

/**
 * Append the send-log entry. Best-effort by contract: a logging failure must
 * never break (or roll back) the business operation the email belonged to, so
 * every failure path lands in the catch and is only logged. The admin SDK is
 * imported lazily so pure-unit consumers of this module (jest) never touch
 * firebase-admin initialisation.
 */
async function appendEmailLog(
  context: EmailDispatchContext,
  message: EmailMessage,
  outcome: EmailLogEntry['outcome'],
  logger: Logger,
): Promise<void> {
  if (!context.orgId || !context.env) {
    return;
  }
  try {
    const { db } = await import('../admin');
    const entry: EmailLogEntry = {
      to: redactRecipient(message.to),
      subject: message.subject,
      category: context.category,
      sentAt: Date.now(),
      outcome,
      // ====
      // Conditional spread, not plain assignment: RTDB rejects any write that
      // carries an `undefined` value, so the optional templating fields may
      // only appear on the entry when the send actually supplied them.
      // ====
      ...(context.kindId !== undefined ? { kindId: context.kindId } : {}),
      ...(context.templateId !== undefined ? { templateId: context.templateId } : {}),
    };
    await db.ref(forEnv(context.env).db.emailLog(context.orgId)).push(entry);
  } catch (error) {
    logger.warn('Email log append failed (send outcome unaffected)', {
      category: context.category,
      outcome,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Dispatch an email. Returns whether it was actually sent (false = no provider
 * configured, intent logged). Never throws to the caller on a provider problem:
 * the invitation/lead record is the source of truth and a failed email must not
 * roll back a successful business operation. Provider errors are logged and
 * surfaced via the boolean so callers can decide whether to show a soft notice.
 */
export async function dispatchEmail(
  message: EmailMessage,
  logger: Logger,
  context?: EmailDispatchContext,
): Promise<boolean> {
  if (!isEmailConfigured()) {
    // Deferred infra, not a stub: we record that we WOULD have emailed, with the
    // address redacted, so the deferral is observable in logs without leaking PII.
    logger.info('Email provider not configured; skipping send', {
      subject: message.subject,
      // The recipient is intentionally redacted; we only note that there was one.
      hasRecipient: message.to.length > 0,
    });
    if (context) {
      await appendEmailLog(context, message, 'skipped-no-provider', logger);
    }
    return false;
  }

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      // An abandoned send lands in the catch below as any other provider
      // failure does, so it is logged and returns false rather than throwing.
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${process.env.EMAIL_PROVIDER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [message.to],
        subject: message.subject,
        text: message.body,
        ...(message.html ? { html: message.html } : {}),
      }),
    });

    if (!response.ok) {
      // Read the provider's reason for the log, but never let a malformed error
      // body turn a failed send into a thrown one.
      const detail = await response.text().catch(() => '');
      logger.error('Email provider rejected the send', {
        status: response.status,
        detail: detail.slice(0, 500),
        subject: message.subject,
      });
      if (context) {
        await appendEmailLog(context, message, 'failed', logger);
      }
      return false;
    }

    logger.info('Email dispatched', { subject: message.subject });
    if (context) {
      await appendEmailLog(context, message, 'sent', logger);
    }
    return true;
  } catch (error) {
    logger.error('Email provider unreachable', {
      subject: message.subject,
      message: error instanceof Error ? error.message : String(error),
    });
    if (context) {
      await appendEmailLog(context, message, 'failed', logger);
    }
    return false;
  }
}
