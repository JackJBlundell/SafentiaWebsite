// ============================================================================
// seedPlans - operator script: make one Stripe mode's billing catalogue real.
//
// For the given mode (--mode test|live, required) it converges three layers on
// the canonical tier definitions below (PLAN_SEEDS):
//   1. PRODUCTS  - ensures safentia_bronze / safentia_silver / safentia_gold
//                  exist with metadata.planId (the field the webhook and this
//                  script resolve tiers from, never the display name).
//   2. PRICES    - ensures each product has its monthly recurring GBP price
//                  with lookup key `safentia_{tier}_monthly`. The lookup key is
//                  the stable cross-mode name (plan section 2); the price ID it
//                  resolves to differs per mode and is cached into RTDB.
//   3. RTDB      - writes the FULL Plan doc (name, stripePriceId,
//                  priceMonthlyPence, currency, features, limits, order) to
//                  /platform/plans/{env}/{planId}, env = the Stripe mode
//                  (test mode -> 'test' tree, live mode -> 'live' tree).
//
// IDEMPOTENT: existing Stripe objects are found and reused, never duplicated -
// prices by lookup key first (the authoritative handle), then products by
// metadata.planId / name; only what is missing is created. Prices are immutable
// in Stripe, so an existing price whose amount differs from PLAN_SEEDS is
// reported LOUDLY and left alone (fix in the dashboard: create the replacement
// price, move the lookup key, re-run). Re-runs simply rewrite the RTDB doc from
// the current derived truth.
//
// DRY RUN BY DEFAULT (backfillUsage precedent): without --apply it only reports
// what it WOULD create/write. Run dry, eyeball the lines, re-run with --apply.
//
// Credentials:
//   - Firebase Admin: standard GOOGLE_APPLICATION_CREDENTIALS +
//     FIREBASE_DATABASE_URL init (see src/admin.ts / grantSuperAdmin).
//   - Stripe: the MODE-MATCHING secret key in the STRIPE_API_KEY env var
//     (sk_test_... for --mode test, sk_live_... for --mode live). The script
//     refuses a key whose mode contradicts --mode so a live catalogue can never
//     be seeded from test objects or vice versa.
//
// Run (from functions/):
//   GOOGLE_APPLICATION_CREDENTIALS=<key.json> \
//   FIREBASE_DATABASE_URL=<rtdb url> \
//   STRIPE_API_KEY=sk_test_... \
//     npx ts-node src/scripts/seedPlans.ts --mode test [--apply]
// ============================================================================

import Stripe from 'stripe';
import { platform } from '../lib/paths';
import type { Environment, Plan, PlanLimits } from '../shared/types';

// ============================================================================
// Canonical tier definitions - THE single place to edit plan commercials.
// ============================================================================

/** One tier's seed: everything about a plan except the mode-specific Stripe
 *  price ID, which this script resolves/creates and injects (buildPlanDoc). */
export interface PlanSeed {
  planId: 'bronze' | 'silver' | 'gold';
  /** Display name (subscribe matrix, Billing tab). */
  name: string;
  /** PROPOSED prices per PHASE3_BILLING_PLAN.md section 1.1 - PENDING USER
   *  SIGN-OFF. Edit here (only here) once the final amounts are approved,
   *  before the first --apply run in each mode. */
  priceMonthlyPence: number;
  features: Plan['features'];
  limits: PlanLimits;
  order: number;
}

/** -1 is the consistent "unlimited" sentinel (shared/types PlanLimits). */
const UNLIMITED = -1;

/** The three tiers, exactly the PHASE3_BILLING_PLAN.md section 1.1 matrix.
 *  Note gold's notification limit is CAPPED (5,000/mo), not unlimited - email
 *  spend is real money and the cap is the abuse ceiling (plan rationale). */
export const PLAN_SEEDS: readonly PlanSeed[] = [
  {
    planId: 'bronze',
    name: 'Bronze',
    priceMonthlyPence: 4900,
    features: { branding: false, emailTemplates: false, prioritySupport: false },
    limits: {
      orgStaff: 3,
      customers: 10,
      notificationsPerMonth: 200,
      assessmentTemplates: 1,
    },
    order: 0,
  },
  {
    planId: 'silver',
    name: 'Silver',
    priceMonthlyPence: 12900,
    features: { branding: true, emailTemplates: true, prioritySupport: false },
    limits: {
      orgStaff: 10,
      customers: 50,
      notificationsPerMonth: 1000,
      assessmentTemplates: 5,
    },
    order: 1,
  },
  {
    planId: 'gold',
    name: 'Gold',
    priceMonthlyPence: 29900,
    features: { branding: true, emailTemplates: true, prioritySupport: true },
    limits: {
      orgStaff: UNLIMITED,
      customers: UNLIMITED,
      notificationsPerMonth: 5000,
      assessmentTemplates: UNLIMITED,
    },
    order: 2,
  },
] as const;

/** Stripe product name for one tier (STRIPE_SETUP.md section 3 table). */
export function productNameFor(planId: PlanSeed['planId']): string {
  return `safentia_${planId}`;
}

/** Stripe price lookup key for one tier - the stable cross-mode handle the
 *  server resolves prices by at subscribe time (plan section 2). */
export function lookupKeyFor(planId: PlanSeed['planId']): string {
  return `safentia_${planId}_monthly`;
}

/** The full RTDB Plan doc for one tier, given the mode's resolved price ID.
 *  Pure - unit-tested; the only mode-varying field is stripePriceId. */
export function buildPlanDoc(seed: PlanSeed, stripePriceId: string): Plan {
  return {
    name: seed.name,
    stripePriceId,
    priceMonthlyPence: seed.priceMonthlyPence,
    currency: 'gbp',
    features: seed.features,
    limits: seed.limits,
    order: seed.order,
  };
}

// ============================================================================
// Argument / credential parsing
// ============================================================================

/** --mode test|live (also accepts --mode=test), or null when absent/invalid. */
export function parseMode(argv: readonly string[]): Environment | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    let value: string | undefined;
    if (arg === '--mode') {
      value = argv[i + 1];
    } else if (arg.startsWith('--mode=')) {
      value = arg.slice('--mode='.length);
    }
    if (value !== undefined) {
      return value === 'test' || value === 'live' ? value : null;
    }
  }
  return null;
}

/** True when the Stripe secret key's own mode matches the requested mode -
 *  test keys carry `_test_`; anything else is a live-mode credential. */
export function keyMatchesMode(key: string, mode: Environment): boolean {
  return key.includes('_test_') === (mode === 'test');
}

// ============================================================================
// Stripe convergence (find-or-create, per tier)
// ============================================================================

/** Find the tier's product: by metadata.planId first (the canonical marker),
 *  falling back to the exact product name for hand-created dashboard objects
 *  that predate the metadata convention. Listing (not the Search API) so the
 *  result is read-consistent - search indexing lags creations. */
async function findProduct(
  stripe: Stripe,
  seed: PlanSeed,
): Promise<Stripe.Product | null> {
  const products = await stripe.products.list({ active: true, limit: 100 });
  return (
    products.data.find((p) => p.metadata?.planId === seed.planId) ??
    products.data.find((p) => p.name === productNameFor(seed.planId)) ??
    null
  );
}

/** Resolve one tier end-to-end against Stripe: reuse the price by lookup key
 *  when it exists (product comes with it), otherwise reuse/create the product
 *  then create the price. Returns null price ID only in dry-run when creation
 *  would be needed. */
async function ensureTier(
  stripe: Stripe,
  seed: PlanSeed,
  apply: boolean,
): Promise<{ priceId: string | null; notes: string[] }> {
  const notes: string[] = [];
  const lookupKey = lookupKeyFor(seed.planId);

  // 1. Price by lookup key - the authoritative existence check: if the price
  //    is there, the catalogue for this tier already exists and is reused.
  const prices = await stripe.prices.list({
    lookup_keys: [lookupKey],
    expand: ['data.product'],
    limit: 1,
  });
  const existingPrice = prices.data[0];
  if (existingPrice) {
    notes.push(`price ${existingPrice.id} found by lookup key ${lookupKey}`);
    if (existingPrice.unit_amount !== seed.priceMonthlyPence) {
      // Prices are immutable; a drift is an operator decision, not ours.
      notes.push(
        `*** AMOUNT DRIFT: Stripe has ${String(existingPrice.unit_amount)}p, ` +
          `seed says ${seed.priceMonthlyPence}p. Existing price kept - to change ` +
          'the amount, create the new price in the dashboard, move the lookup ' +
          'key to it, and re-run. ***',
      );
    }
    if (existingPrice.currency !== 'gbp') {
      notes.push(
        `*** CURRENCY DRIFT: existing price is ${existingPrice.currency}, expected gbp. ***`,
      );
    }
    const product = existingPrice.product;
    if (
      typeof product !== 'string' &&
      !product.deleted &&
      product.metadata?.planId !== seed.planId
    ) {
      // Backfill the canonical marker on a hand-created product.
      if (apply) {
        await stripe.products.update(product.id, {
          metadata: { ...product.metadata, planId: seed.planId },
        });
        notes.push(`product ${product.id}: metadata.planId set to '${seed.planId}'`);
      } else {
        notes.push(`product ${product.id}: would set metadata.planId='${seed.planId}'`);
      }
    }
    return { priceId: existingPrice.id, notes };
  }

  // 2. No price yet: reuse or create the product, then create the price.
  let product = await findProduct(stripe, seed);
  if (product) {
    notes.push(`product ${product.id} found (${product.name})`);
    if (product.metadata?.planId !== seed.planId) {
      if (apply) {
        await stripe.products.update(product.id, {
          metadata: { ...product.metadata, planId: seed.planId },
        });
        notes.push(`product ${product.id}: metadata.planId set to '${seed.planId}'`);
      } else {
        notes.push(`product ${product.id}: would set metadata.planId='${seed.planId}'`);
      }
    }
  } else if (apply) {
    product = await stripe.products.create({
      name: productNameFor(seed.planId),
      metadata: { planId: seed.planId },
    });
    notes.push(`product ${product.id} CREATED (${product.name})`);
  } else {
    notes.push(`product ${productNameFor(seed.planId)} would be CREATED`);
  }

  if (!apply) {
    notes.push(`price with lookup key ${lookupKey} would be CREATED (${seed.priceMonthlyPence}p/mo gbp)`);
    return { priceId: null, notes };
  }
  if (!product) {
    throw new Error(`invariant: product missing for ${seed.planId} in apply mode`);
  }
  const created = await stripe.prices.create({
    product: product.id,
    currency: 'gbp',
    unit_amount: seed.priceMonthlyPence,
    recurring: { interval: 'month' },
    lookup_key: lookupKey,
    nickname: `${seed.name} monthly`,
  });
  notes.push(`price ${created.id} CREATED (lookup key ${lookupKey}, ${seed.priceMonthlyPence}p/mo)`);
  return { priceId: created.id, notes };
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));
  if (!mode) {
    console.error('Usage: npx ts-node src/scripts/seedPlans.ts --mode test|live [--apply]');
    process.exit(1);
    return;
  }
  const apply = process.argv.includes('--apply');

  const stripeKey = process.env.STRIPE_API_KEY;
  if (!stripeKey) {
    console.error(
      'STRIPE_API_KEY is not set. Export the mode-matching secret key ' +
        `(${mode === 'test' ? 'sk_test_...' : 'sk_live_...'}) and re-run.`,
    );
    process.exit(1);
    return;
  }
  if (!keyMatchesMode(stripeKey, mode)) {
    console.error(
      `STRIPE_API_KEY is a ${mode === 'test' ? 'LIVE' : 'TEST'}-mode key but ` +
        `--mode is '${mode}'. Refusing to cross the streams; pass the matching key.`,
    );
    process.exit(1);
    return;
  }

  console.log(
    apply
      ? `APPLY mode (${mode}): missing Stripe objects WILL be created and ` +
        `/platform/plans/${mode} WILL be written.`
      : `DRY RUN (default, ${mode}): nothing will be created or written. ` +
        'Re-run with --apply to converge.',
  );
  console.log(
    'NOTE: amounts are the PROPOSED section 1.1 prices pending user sign-off - ' +
      'confirm PLAN_SEEDS before an --apply run.',
  );

  const stripe = new Stripe(stripeKey, { appInfo: { name: 'safentia' } });
  // Lazy admin import so jest can unit-test the pure parts without touching
  // firebase-admin initialisation (lib/stripe.ts precedent).
  const { db } = await import('../admin');

  let written = 0;
  for (const seed of PLAN_SEEDS) {
    console.log(`\n[${mode}] ${seed.planId}`);
    const { priceId, notes } = await ensureTier(stripe, seed, apply);
    for (const note of notes) {
      console.log(`  - ${note}`);
    }
    if (priceId === null) {
      console.log(
        `  - /platform/plans/${mode}/${seed.planId} would be written once the price exists`,
      );
      continue;
    }
    const doc = buildPlanDoc(seed, priceId);
    if (apply) {
      await db.ref(platform.plan(mode, seed.planId)).set(doc);
      written += 1;
      console.log(`  - /platform/plans/${mode}/${seed.planId} written (stripePriceId=${priceId})`);
    } else {
      console.log(
        `  - would write /platform/plans/${mode}/${seed.planId}: ${JSON.stringify(doc)}`,
      );
    }
  }

  console.log('\nSummary');
  console.log(`  tiers converged: ${PLAN_SEEDS.length}, plan docs written: ${written}`);
  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to create/write.');
  }
  process.exit(0);
}

// Guarded so jest can import the pure exports (PLAN_SEEDS, buildPlanDoc,
// parseMode, keyMatchesMode) without running the script.
if (require.main === module) {
  void main().catch((error) => {
    console.error('seedPlans failed:', error);
    process.exit(1);
  });
}
