// ============================================================================
// SubscribePlanPage - step TWO of self-serve onboarding (Phase 3 §3.1):
// choose a tier. The organisation's details were collected by the preceding
// OrgDetailsPage (saveOnboardingDetails owns the node), so this page is plan
// choice ONLY - it shows who the plan is for and offers an "edit details"
// way back. Renders inside the shared SubscribeChrome, reading the plan
// catalogue live from /platform/plans/{env} (authed-read platform data).
//
// The feature list is derived from the plan's real limits and flags: what the
// tier actually meters, no marketing gloss. The MIDDLE tier of a full matrix
// is quietly recommended ("Most popular") so the choice feels considered
// rather than flat.
// ============================================================================

import { useMemo } from 'react';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import { keys } from '../../query/keys';
import { platform } from '../../paths';
import type { Environment, Plan, PlanLimits } from '../../types';
import { Button } from '../../components/Button';
import { EmptyState, ErrorNotice } from '../ui/Page';
import { Skeleton } from '../ui/Skeleton';
import { SubscribeChrome } from './SubscribeChrome';
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

/** One metered line: "-1" is the unlimited sentinel across every limit. */
function limitLine(count: number, singular: string, plural: string): string {
  if (count === -1) return `Unlimited ${plural}`;
  return `${count} ${count === 1 ? singular : plural}`;
}

/** The honest feature list for a tier, straight from limits + flags. Exported
 *  for the subscribe tests. */
export function planFeatureLines(plan: Plan): string[] {
  const limits: PlanLimits = plan.limits;
  const lines = [
    limitLine(limits.orgStaff, 'staff member', 'staff members'),
    limitLine(limits.customers, 'customer', 'customers'),
    limits.notificationsPerMonth === -1
      ? 'Unlimited notifications each month'
      : `${limits.notificationsPerMonth} notifications each month`,
    limitLine(
      limits.assessmentTemplates,
      'assessment template',
      'assessment templates',
    ),
  ];
  if (plan.features.branding) lines.push('Your own branding and logo');
  if (plan.features.emailTemplates) lines.push('Customisable email templates');
  if (plan.features.prioritySupport) lines.push('Priority support');
  return lines;
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
              <ul className={styles.featureList}>
                {planFeatureLines(plan).map((line) => (
                  <li key={line} className={styles.featureItem}>
                    {line}
                  </li>
                ))}
              </ul>
              <Button block onClick={() => onChoose({ planId: id, plan })}>
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
