// ============================================================================
// sendManualEmail (callable, admin-only) - explicit one-off send of an org
// template to up to fifty recipients.
//
// Unlike the automated kinds, a manual send is a DELIBERATE act: the admin
// chose a specific template, so a missing or malformed template is an error
// (invalid-argument), never a silent fallback to built-in copy. Recipients are
// named by reference wherever possible (member uid / customer contact pair) so
// the server resolves the CURRENT address - a stale client cannot mail an old
// one - and every address returned to the client is redacted (j***@example.com,
// data minimisation, brief 18.4). One activity entry records the send (template
// id + recipient count, never addresses).
//
// ABUSE POSTURE (Phase 3 assessment H3). This is the one endpoint that mails
// ARBITRARY external addresses from the platform's verified sending domain, so
// the asset at risk is that domain's deliverability for every tenant, not
// compute. Three stacked controls:
//   1. Per-user rate limit: 5 calls/HOUR (lib/rateLimit) - a deliberate batch
//      cadence, not a pump.
//   2. Per-ORG daily cap: at most 200 recipients/day, charged atomically
//      BEFORE dispatch and all-or-nothing (lib/manualEmailLimits) - a
//      compromised or hostile admin cannot relay at volume, and colluding
//      admin accounts share one org bucket.
//   3. The existing 50-recipient/call contract cap plus strict recipient
//      validation below.
// The results array maps 1:1 to the INPUT recipients array (same length, same
// order, each row carrying its input index) so the caller can see honestly
// what happened to every address it named - including duplicates, which are
// reported, not silently dropped.
// ============================================================================

import { onCall } from 'firebase-functions/v2/https';
import { db } from '../admin';
import { callableOptions } from '../lib/callable';
import { createLogger } from '../lib/logging';
import { fail, runCallable } from '../lib/errors';
import {
  assertAppCheck,
  assertAuth,
  assertOrgRole,
  getClaims,
  envFor,
} from '../lib/guards';
import { assertObject, requireString, requireEmail } from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { chargeManualEmailQuota } from '../lib/manualEmailLimits';
import { activityUpdate } from '../lib/events';
import {
  EMAIL_PROVIDER_SECRETS,
  isEmailConfigured,
  redactRecipient,
} from '../lib/email';
import { isRenderableTemplate } from '../lib/emailVariableEngine';
import { orgEmailBrand } from '../lib/emailTemplates';
import { assertFeature, resolvePlanContext } from '../lib/planContext';
import { sendKindEmail, type KindConfig } from '../lib/templatedEmail';
import type {
  CustomerContact,
  ManualEmailRecipient,
  OrgMember,
  OrgProfile,
  SendManualEmailInput,
  SendManualEmailResult,
} from '../shared/types';

// ====
// Input bounds. Fifty recipients is the contract cap (shared type doc); the
// variable caps keep a hostile payload from smuggling megabytes through a
// "string" field - real template variable values are short phrases.
// ====
const MAX_RECIPIENTS = 50;
const MAX_VARIABLES = 50;
const MAX_VARIABLE_KEY = 100;
const MAX_VARIABLE_VALUE = 2000;

/** The exact key set each recipient shape may carry. Extra keys are rejected,
 *  not dropped - same no-smuggling posture as requireRoleSet. */
const RECIPIENT_KEYS: Record<ManualEmailRecipient['type'], readonly string[]> = {
  member: ['type', 'uid'],
  contact: ['type', 'customerId', 'contactId'],
  email: ['type', 'email'],
};

/** Validate one recipient strictly: a known `type`, EXACTLY that shape's keys,
 *  and each field a valid value. Rejects, never coerces (brief 18.4). */
function requireRecipient(value: unknown, index: number): ManualEmailRecipient {
  const rec = assertObject(value);
  const type = rec.type;
  if (type !== 'member' && type !== 'contact' && type !== 'email') {
    throw fail.invalidArgument(
      `Recipient ${index} must have type 'member', 'contact' or 'email'.`,
      { index },
    );
  }
  const allowed = RECIPIENT_KEYS[type];
  const keys = Object.keys(rec);
  if (keys.length !== allowed.length || !keys.every((k) => allowed.includes(k))) {
    throw fail.invalidArgument(
      `Recipient ${index} carries fields that do not belong to the '${type}' shape.`,
      { index },
    );
  }
  switch (type) {
    case 'member':
      return { type, uid: requireString(rec, 'uid', 128) };
    case 'contact':
      return {
        type,
        customerId: requireString(rec, 'customerId', 128),
        contactId: requireString(rec, 'contactId', 128),
      };
    case 'email':
      // requireEmail is the strict syntactic check the rest of the platform
      // uses (exactly one @, non-empty parts, dotted domain); it lowercases,
      // which also feeds the case-insensitive dedupe below.
      return { type, email: requireEmail(rec, 'email') };
  }
}

/** Validate the optional caller variables: string -> string only, and no keys
 *  in the server-derived namespaces - `org.*` / `recipient.*` are computed per
 *  recipient below and a caller must not be able to spoof them. */
function requireVariables(value: unknown): Record<string, string> {
  const input = assertObject(value);
  const entries = Object.entries(input);
  if (entries.length > MAX_VARIABLES) {
    throw fail.invalidArgument('Too many variables supplied.');
  }
  const variables: Record<string, string> = {};
  for (const [key, val] of entries) {
    if (key.length === 0 || key.length > MAX_VARIABLE_KEY) {
      throw fail.invalidArgument('A variable name is empty or too long.');
    }
    if (key.startsWith('org.') || key.startsWith('recipient.')) {
      throw fail.invalidArgument(
        `The variable '${key}' is server-derived and cannot be supplied.`,
      );
    }
    if (typeof val !== 'string' || val.length > MAX_VARIABLE_VALUE) {
      throw fail.invalidArgument(
        `The variable '${key}' must be a string of at most ${MAX_VARIABLE_VALUE} characters.`,
      );
    }
    variables[key] = val;
  }
  return variables;
}

/** One input recipient's resolution verdict, still in input order. */
interface ResolvedEntry {
  name: string;
  /** The resolved address, or '' when the reference resolved to nothing. */
  email: string;
  valid: boolean;
}

/** One planned slot per INPUT recipient: the same index, the resolved address,
 *  and whether it will be dispatched ('ok'), was unresolvable, or repeats an
 *  earlier address. */
export interface RecipientSlot {
  /** Index into the input recipients array. */
  recipient: number;
  name: string;
  email: string;
  status: 'ok' | 'invalid-recipient' | 'duplicate';
}

/**
 * Plan the send from the resolved entries: EXACTLY one slot per input
 * recipient, in input order. Dedupe is case-insensitive on the resolved
 * address and first-wins - the first occurrence is dispatched, every repeat
 * becomes a 'duplicate' slot (reported to the caller, never sent twice, never
 * charged against the daily cap). Pure, so the 1:1 contract is unit-testable.
 */
export function planRecipientSlots(
  entries: readonly ResolvedEntry[],
): RecipientSlot[] {
  const seen = new Set<string>();
  return entries.map((entry, index) => {
    if (!entry.valid) {
      return { recipient: index, name: '', email: '', status: 'invalid-recipient' as const };
    }
    const dedupeKey = entry.email.toLowerCase();
    if (seen.has(dedupeKey)) {
      return { recipient: index, name: entry.name, email: entry.email, status: 'duplicate' as const };
    }
    seen.add(dedupeKey);
    return { recipient: index, name: entry.name, email: entry.email, status: 'ok' as const };
  });
}

export const sendManualEmail = onCall<SendManualEmailInput>(
  { ...callableOptions, secrets: EMAIL_PROVIDER_SECRETS },
  (request) =>
    runCallable<SendManualEmailResult>(
      createLogger({ fn: 'sendManualEmail' }),
      async () => {
        // 1. Attestation, identity, authorisation (canonical guard order).
        assertAppCheck(request);
        const { uid } = assertAuth(request);
        await assertRateLimit(uid, 'sendManualEmail');
        const claims = getClaims(request);
        assertOrgRole(claims, 'admin');
        const { env, paths } = envFor(claims);
        const orgId = claims.orgId;
        const logger = createLogger({ fn: 'sendManualEmail', orgId });

        // 2. Strict validation - reject, never coerce (brief 18.4).
        const input = assertObject(request.data);
        const templateId = requireString(input, 'templateId', 200);
        if (!Array.isArray(input.recipients) || input.recipients.length === 0) {
          throw fail.invalidArgument('Provide at least one recipient.');
        }
        if (input.recipients.length > MAX_RECIPIENTS) {
          throw fail.invalidArgument(
            `A manual send is limited to ${MAX_RECIPIENTS} recipients.`,
          );
        }
        const recipients = input.recipients.map((r, i) => requireRecipient(r, i));
        const callerVariables =
          input.variables === undefined ? {} : requireVariables(input.variables);

        // 3. Email templates are a plan feature (Phase 3 §6): a manual send IS
        // the feature (it renders nothing but an org template), so without it
        // the send is refused outright with the calm upsell the console
        // renders - unlike the automated kinds, which merely fall back to
        // built-in copy. The same resolved context supplies the branding flag
        // for the config below, so this is the call's one plan read.
        const planContext = await resolvePlanContext(paths, orgId);
        assertFeature(
          planContext.entitlements,
          'emailTemplates',
          'Sending your own email templates is included from the Silver plan. Upgrade to send custom emails; your saved templates are kept safe.',
        );

        // The chosen template must exist AND be renderable. A manual send is
        // an explicit act, so - unlike the automated kinds, which degrade to
        // built-in copy - a bad template here is the CALLER's error and the
        // send is refused rather than silently substituted.
        const templateDoc: unknown = (
          await db.ref(paths.db.emailTemplate(orgId, templateId)).get()
        ).val();
        if (!isRenderableTemplate(templateDoc)) {
          throw fail.invalidArgument(
            'The selected template does not exist or is not renderable.',
            { templateId },
          );
        }

        // 4. Resolve each reference to its CURRENT name + address. An
        // unresolvable reference (missing/inactive member, missing contact, no
        // stored address) is a PER-RECIPIENT outcome, not a thrown error: the
        // other forty-nine recipients still get their email.
        const entries: ResolvedEntry[] = [];
        for (const rec of recipients) {
          let name = '';
          let email = '';
          let valid = false;
          if (rec.type === 'member') {
            const member = (
              await db.ref(paths.db.orgMember(orgId, rec.uid)).get()
            ).val() as OrgMember | null;
            if (
              member !== null &&
              member.status === 'active' &&
              typeof member.email === 'string' &&
              member.email.length > 0
            ) {
              name = member.name;
              email = member.email;
              valid = true;
            }
          } else if (rec.type === 'contact') {
            const contact = (
              await db
                .ref(paths.db.customerContact(orgId, rec.customerId, rec.contactId))
                .get()
            ).val() as CustomerContact | null;
            if (
              contact !== null &&
              typeof contact.email === 'string' &&
              contact.email.length > 0
            ) {
              name = contact.name;
              email = contact.email;
              valid = true;
            }
          } else {
            // A raw address was validated syntactically above; there is no
            // stored record to name the person, so the name renders empty.
            email = rec.email;
            valid = true;
          }

          entries.push({ name, email, valid });
        }

        // Plan the slots: one per input recipient, in input order, with
        // case-insensitive first-wins dedupe. Only 'ok' slots are dispatched
        // (and charged); duplicates are reported honestly, mailed once.
        const slots = planRecipientSlots(entries);
        const deliverable = slots.filter((slot) => slot.status === 'ok');

        // 5. Brand + kind config. For 'manual' the assigned-template mechanism
        // does not apply (there is no settings node to consult - the caller
        // named the template), so the config is constructed directly and the
        // seam renders EXACTLY the validated template for every recipient.
        const profile = (
          await db.ref(paths.db.orgProfile(orgId)).get()
        ).val() as OrgProfile | null;
        const brand = orgEmailBrand(profile);
        const config: KindConfig = {
          kind: 'manual',
          enabled: true,
          template: templateDoc,
          templateId,
          // From the plan context resolved at step 3, so the branding gate in
          // sendKindEmail applies to manual sends exactly as it does to the
          // automated kinds.
          brandingAllowed: planContext.entitlements.features.branding,
        };

        // 6. Charge the org's daily allowance, then send. The charge covers
        // exactly the post-dedupe deliverable count, lands atomically BEFORE
        // the first dispatch, and is all-or-nothing: a batch that would cross
        // the cap throws resource-exhausted here and NOTHING below runs - see
        // lib/manualEmailLimits for why partial delivery is refused. With no
        // provider secret mounted nothing will leave the platform at all, so
        // nothing is charged either (the quota meters real emails, and a
        // configuration gap must not eat the day's allowance).
        const configured = isEmailConfigured();
        if (configured) {
          await chargeManualEmailQuota(env, orgId, deliverable.length);
        }

        // Outcome mapping, honestly stated: with no provider secret mounted
        // nothing is attempted at all, so every deliverable slot reports
        // 'skipped-no-provider' (NOT 'failed' - the seam was never asked).
        // With a provider, sendKindEmail's boolean is the provider's verdict:
        // true -> 'sent', false -> 'failed'. sendKindEmail never throws.
        const sendOutcomes = new Map<
          number,
          'sent' | 'skipped-no-provider' | 'failed'
        >();
        for (const person of deliverable) {
          if (!configured) {
            sendOutcomes.set(person.recipient, 'skipped-no-provider');
            continue;
          }
          const delivered = await sendKindEmail(
            {
              kind: 'manual',
              env,
              orgId,
              to: person.email,
              variables: {
                // Server-derived namespaces first; validation already refused
                // any caller key that could collide with them.
                'org.name': brand.name,
                'recipient.name': person.name,
                'recipient.email': person.email,
                ...callerVariables,
              },
              brand,
              config,
            },
            logger,
          );
          sendOutcomes.set(person.recipient, delivered ? 'sent' : 'failed');
        }

        // One result row per INPUT recipient, in input order (the shared-type
        // contract): the caller joins each row back to its request by index.
        // redactRecipient('') yields '***' for the unresolved, so no address -
        // even a redacted one - is invented.
        const results: SendManualEmailResult['results'] = slots.map((slot) => ({
          recipient: slot.recipient,
          to: redactRecipient(slot.email),
          outcome:
            slot.status === 'ok'
              ? (sendOutcomes.get(slot.recipient) ?? 'failed')
              : slot.status,
        }));

        // 7. ONE activity entry for the whole send: template + how many people
        // were attempted, never addresses (the emailLog holds the redacted
        // per-send trail).
        await db.ref().update(
          activityUpdate(paths, orgId, {
            actorUid: uid,
            action: 'email.manualSend',
            target: `${templateId} (${deliverable.length} recipients)`,
          }),
        );

        logger.info('Manual email send completed', {
          templateId,
          attempted: deliverable.length,
          invalid: results.filter((r) => r.outcome === 'invalid-recipient').length,
          duplicates: results.filter((r) => r.outcome === 'duplicate').length,
        });
        return { results };
      },
    ),
);
