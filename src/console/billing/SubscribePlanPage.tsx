// ============================================================================
// SubscribePlanPage - step TWO of self-serve onboarding (Phase 3 §3.1):
// choose a tier. The organisation's details were collected by the preceding
// OrgDetailsPage (saveOnboardingDetails owns the node), so this page is plan
// choice ONLY - it shows who the plan is for and offers an "edit details"
// way back. Renders inside the shared SubscribeChrome, reading the plan
// catalogue live from /platform/plans/{env} (authed-read platform data).
//
// Each card shows the SAME comparison rows (story 3018 AC2), so a buyer can
// see what a tier LACKS as plainly as what it includes - every row is present
// on every card, a metered value or a tick where included and a "-" where not.
// The numbers come straight from the plan's real limits and flags, never
// marketing copy. The MIDDLE tier of a full matrix is quietly recommended
// ("Most popular") so the choice feels considered rather than flat.
// ============================================================================

import { useMemo } from 'react';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import { keys } from '../../query/keys';
import { platform } from '../../paths';
import type { Environment, Plan } from '../../types';
import { Button } from '../../components/Button';
import { EmptyState, ErrorNotice } from '../ui/Page';
import { Skeleton } from '../ui/Skeleton';
import { SubscribeChrome } from './SubscribeChrome';
import { isStripeConfiguredForEnv } from './stripeClient';
import styles from './SubscribePlanPage.module.css';

export interface PlanChoice {
  planId: string;
  /** The chosen plan document, carried along so the payment step can show an
   *  order summary (name and price) without re-reading the catalogue. */
  plan: Plan;
}

/** Pence to display price: whole pounds stay whole ("£49"), anything else
 *  keeps its two places ("£49.50"). Display only - Stripe is the billing
 *  truth. Exported for the subscribe tests. */
export function formatMonthlyPrice(pence: number): string {
  const pounds = pence / 100;
  return Number.isInteger(pounds) ? `£${pounds}` : `£${pounds.toFixed(2)}`;
}

/** A metered limit as a display value: "-1" is the unlimited sentinel across
 *  every limit, everything else is its own count. */
function limitValue(count: number): string {
  return count === -1 ? 'Unlimited' : String(count);
}

/** One comparison row: a `string` value is a metered count; a `boolean` is a
 *  whole-surface feature flag, rendered as a tick when included and a "-" when
 *  not, so an excluded feature is still SHOWN rather than dropped. */
export interface PlanRow {
  label: string;
  value: string | boolean;
}

/**
 * The fixed comparison rows for a tier, in a single order shared by every card
 * so the matrix reads straight across (story 3018 AC2). Sourced entirely from
 * the plan's real limits and feature flags - the same shape the entitlements
 * module meters against - never hardcoded per tier. Exported for the tests.
 */
export function planMatrixRows(plan: Plan): PlanRow[] {
  const { limits, features } = plan;
  return [
    { label: 'Staff members', value: limitValue(limits.orgStaff) },
    { label: 'Customers', value: limitValue(limits.customers) },
    {
      label: 'Notifications each month',
      value: limitValue(limits.notificationsPerMonth),
    },
    { label: 'Custom branding', value: features.branding },
    { label: 'Custom email templates', value: features.emailTemplates },
    {
      label: 'Assessment templates',
      value: limitValue(limits.assessmentTemplates),
    },
    { label: 'Priority support', value: features.prioritySupport },
  ];
}

/** Sort the catalogue node into display order. Exported for the tests: this is
 *  the one rule that decides how the matrix reads. */
export function sortPlans(
  node: Record<string, Plan> | null | undefined,
): Array<{ id: string; plan: Plan }> {
  if (!node) return [];
  return Object.entries(node)
    .map(([id, plan]) => ({ id, plan }))
    .sort((a, b) => a.plan.order - b.plan.order);
}

export interface SubscribePlanPageProps {
  env: Environment;
  /** The saved organisation name, shown so the buyer knows the plan is being
   *  chosen for the details they just gave. */
  orgName: string;
  onChoose: (choice: PlanChoice) => void;
  /** Back to the details step to edit what was saved. */
  onEditDetails: () => void;
  /** The secondary path: swap to the invitation-wait (holding) view. */
  onShowHolding: () => void;
}

export function SubscribePlanPage({
  env,
  orgName,
  onChoose,
  onEditDetails,
  onShowHolding,
}: SubscribePlanPageProps) {
  const plansQuery = useRtdbQuery<Record<string, Plan> | null>({
    key: keys.platformPlans(env),
    path: platform.plans(env),
  });
  const plans = useMemo(() => sortPlans(plansQuery.data), [plansQuery.data]);
  // The middle tier of a full matrix is the quiet recommendation.
  const popularIndex = plans.length >= 3 ? 1 : -1;
  // Client-side gate (assessment 1.4): without a publishable key for this env,
  // createSubscription would mint a Stripe customer + subscription for a
  // checkout the browser can never confirm. Only the browser knows its own key
  // state, so the guard lives here - the choice boundary - and blocks the
  // advance before onChoose is ever called, showing the calm notice instead.
  const stripeConfigured = isStripeConfiguredForEnv(env);

  return (
    <SubscribeChrome
      step={1}
      width="wide"
      heading="Choose your plan"
      lede={
        <>
          Setting up <strong className={styles.orgName}>{orgName}</strong>
          {' - '}
          <button
            type="button"
            className={styles.editDetailsLink}
            onClick={onEditDetails}
          >
            edit details
          </button>
          . You can change or cancel your plan at any time.
        </>
      }
    >
      {plansQuery.isLoading && (
        <div className={styles.planGrid} aria-hidden="true">
          <Skeleton height="18rem" />
          <Skeleton height="18rem" />
          <Skeleton height="18rem" />
        </div>
      )}

      {plansQuery.isError && (
        <ErrorNotice message="The plans could not be loaded. Check your connection and try again." />
      )}

      {!plansQuery.isLoading && !plansQuery.isError && plans.length === 0 && (
        <EmptyState
          title="Plans are not available yet"
          body="Subscriptions have not been switched on for this environment. If you were expecting to subscribe, contact the Safentia team."
        />
      )}

      {plans.length > 0 && !stripeConfigured && (
        <p className={styles.notConfiguredNotice} role="status">
          Payments are not available just yet, so a plan cannot be started right
          now. Please try again later, or contact us if this keeps happening.
        </p>
      )}

      {plans.length > 0 && (
        <ul className={styles.planGrid}>
          {plans.map(({ id, plan }, index) => (
            <li
              key={id}
              className={
                index === popularIndex ? styles.planCardPopular : styles.planCard
              }
            >
              {index === popularIndex && (
                <span className={styles.popularTag}>Most popular</span>
              )}
              <h2 className={styles.planName}>{plan.name}</h2>
              <p className={styles.planPrice}>
                <span className={styles.planPriceAmount}>
                  {formatMonthlyPrice(plan.priceMonthlyPence)}
                </span>{' '}
                <span className={styles.planPricePeriod}>per month</span>
              </p>
              <dl className={styles.featureList}>
                {planMatrixRows(plan).map((row) => (
                  <div key={row.label} className={styles.featureRow}>
                    <dt className={styles.featureLabel}>{row.label}</dt>
                    <dd className={styles.featureValue}>
                      {typeof row.value === 'boolean' ? (
                        row.value ? (
                          <span
                            className={styles.included}
                            aria-label="Included"
                          >
                            ✓
                          </span>
                        ) : (
                          <span
                            className={styles.excluded}
                            aria-label="Not included"
                          >
                            -
                          </span>
                        )
                      ) : (
                        row.value
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
              <Button
                block
                disabled={!stripeConfigured}
                onClick={() => onChoose({ planId: id, plan })}
              >
                Choose {plan.name}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {plans.length > 0 && (
        <p className={styles.vatNote}>
          Prices exclude VAT, which is added at the applicable rate.
        </p>
      )}

      {/* The old default is the new secondary: joining an existing
          organisation happens by invitation, and that wait view is one calm
          click away rather than a competing branch. */}
      <p className={styles.holdingSwap}>
        Expecting an invitation from an existing organisation?{' '}
        <button
          type="button"
          className={styles.holdingSwapLink}
          onClick={onShowHolding}
        >
          Wait for your invitation instead
        </button>
      </p>
    </SubscribeChrome>
  );
}
