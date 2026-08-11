// ============================================================================
// listInvoices (callable, org admin) - Phase 3 billing, plan section 9.
//
// A read-through to Stripe's invoice list for the org's customer, mapped onto
// the InvoiceSummary contract (lib/billing) so the Billing tab renders history
// without the client ever talking to the Stripe API. Links are the
// Stripe-hosted invoice page and PDF, which keeps invoice delivery out of PCI
// scope. Pure read: NO RTDB writes and no audit entry - reading your own
// invoices changes nothing.
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
import {
  assertObject,
  optionalString,
  requireDbKey,
  TEXT_LIMITS,
} from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { stripeForEnv, STRIPE_SECRETS } from '../lib/stripe';
import { toInvoiceSummary } from '../lib/billing';
import type {
  InvoiceSummary,
  ListInvoicesRequest,
  ListInvoicesResponse,
  OrgSubscription,
} from '../shared/types';

/** Page-size bounds: a sensible default screen of history, capped so no caller
 *  can turn one call into a bulk export. */
const DEFAULT_PAGE_SIZE = 12;
const MAX_PAGE_SIZE = 24;

/**
 * Validate the payload. The orgId must equal the caller's claims-bound org and
 * is never trusted beyond that check; `limit` is clamped to the cap rather
 * than rejected (asking for more history is not abuse, it just gets a page);
 * `startingAfter` is an opaque Stripe cursor - shape-checked only, Stripe
 * validates it for real. Exported for unit tests.
 */
export function parseListInvoicesInput(
  data: unknown,
  claimsOrgId: string,
): { limit: number; startingAfter?: string } {
  const input = assertObject(data);
  const orgId = requireDbKey(input, 'orgId', TEXT_LIMITS.shortText);
  if (orgId !== claimsOrgId) {
    throw fail.permissionDenied(
      'You can only view billing for your own organisation.',
      { field: 'orgId' },
    );
  }
  let limit = DEFAULT_PAGE_SIZE;
  if (input.limit !== undefined) {
    if (
      typeof input.limit !== 'number' ||
      !Number.isInteger(input.limit) ||
      input.limit < 1
    ) {
      throw fail.invalidArgument(
        'The limit field must be a whole number of at least 1.',
        { field: 'limit' },
      );
    }
    limit = Math.min(input.limit, MAX_PAGE_SIZE);
  }
  const startingAfter = optionalString(
    input,
    'startingAfter',
    TEXT_LIMITS.shortText,
  );
  return { limit, ...(startingAfter ? { startingAfter } : {}) };
}

export const listInvoices = onCall<ListInvoicesRequest>(
  { ...callableOptions, secrets: STRIPE_SECRETS },
  (request) =>
    runCallable<ListInvoicesResponse>(
      createLogger({ fn: 'listInvoices' }),
      async () => {
        // 1. Attestation, identity, authorisation, throttle, validation.
        assertAppCheck(request);
        const { uid } = assertAuth(request);
        const claims = getClaims(request);
        assertOrgRole(claims, 'admin');
        const { env, paths: envPaths } = envFor(claims);
        await assertRateLimit(uid, 'listInvoices');
        const orgId = claims.orgId;
        const { limit, startingAfter } = parseListInvoicesInput(
          request.data,
          orgId,
        );

        // 2. The org must have a Stripe customer to have any history at all.
        const snapshot = await db
          .ref(envPaths.db.orgSubscription(orgId))
          .get();
        const subscription = (snapshot.val() ?? null) as OrgSubscription | null;
        if (!subscription?.stripeCustomerId) {
          throw fail.failedPrecondition(
            'This organisation does not have any billing history yet. ' +
              'If that seems wrong, please contact support.',
          );
        }

        // 3. Read the page from Stripe and map it onto the contract. Drafts
        // map to null (never part of history - see toInvoiceSummary) and are
        // dropped; the cursor is an invoice id, so pagination still composes.
        const stripe = stripeForEnv(env);
        const page = await stripe.invoices.list({
          customer: subscription.stripeCustomerId,
          limit,
          ...(startingAfter ? { starting_after: startingAfter } : {}),
        });
        const invoices = page.data
          .map(toInvoiceSummary)
          .filter((summary): summary is InvoiceSummary => summary !== null);

        return { invoices, hasMore: page.has_more };
      },
    ),
);
