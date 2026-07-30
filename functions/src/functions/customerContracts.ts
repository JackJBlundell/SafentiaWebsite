// ============================================================================
// customerContracts (scheduled) - end a customer's access when their contract
// end date passes.
//
// An admin may give a customer an optional `contractEndDate`: the last day of
// the engagement. This sweep runs every morning and, for every customer whose
// end day has FULLY PASSED, does exactly what an admin pressing "Archive"
// does - flips the customer to archived and withdraws their people's portal
// access (lib/customerAccess) - then tells the organisation's admins it has
// happened, in-app and by email.
//
// It is a convenience over the archive action, never a second source of truth:
// `status` alone decides whether a customer is live, so there is no way for a
// date and a status to disagree about who has access. Restoring a customer
// clears an end date that has already passed (see manageCustomer), so a restore
// cannot be quietly undone by the next morning's sweep.
//
// TIMING: 07:00, half an hour ahead of reviewReminders. A customer whose
// contract ended overnight is therefore archived BEFORE the review sweep runs,
// so their contacts are not emailed about an FRA review on the morning their
// relationship with the organisation ended.
//
// "Fully passed" matches the platform's other date semantics (reviewWindows'
// lapsed notice): a contract ending on the 31st is honoured all through the
// 31st and archived on the 1st.
//
// Idempotency: the guard IS the state change. Only an `active` customer is
// archived, and the flip lands in the same atomic update as the cascade and the
// audit entry, so a scheduler redelivery finds the customer already archived and
// does nothing.
// ============================================================================

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db } from '../admin';
import { REGION } from '../lib/region';
import { createLogger } from '../lib/logging';
import { forEnv } from '../shared/paths';
import { WEB_ORIGIN } from '../lib/webOrigin';
import { sendNotification } from '../lib/notifications';
import { dispatchEmail, EMAIL_PROVIDER_SECRETS } from '../lib/email';
import {
  orgEmailBrand,
  renderBrandedEmail,
  type EmailBrand,
} from '../lib/emailTemplates';
import { portalAccessCascade } from '../lib/customerAccess';
import { activityUpdate } from '../lib/events';
import { utcDayNumber } from '../lib/reviewWindows';
import { SYSTEM_ACTOR_UID } from '../shared/types';
import type {
  Customer,
  Environment,
  OrgMember,
  OrgProfile,
} from '../shared/types';

const ENVIRONMENTS: Environment[] = ['live', 'test'];

/** The contract end day, written the way a person reads a date. */
function formatDate(millis: number): string {
  return new Date(millis).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export const customerContracts = onSchedule(
  {
    schedule: '0 7 * * *',
    timeZone: 'Europe/London',
    region: REGION,
    secrets: EMAIL_PROVIDER_SECRETS,
  },
  async () => {
    const logger = createLogger({ fn: 'customerContracts' });
    const now = Date.now();
    const today = utcDayNumber(now);
    let archived = 0;

    for (const env of ENVIRONMENTS) {
      const paths = forEnv(env);
      // One read of the env's customer tree: { orgId: { customerId: Customer } }.
      const snap = await db.ref(`${env}/customers`).get();
      if (!snap.exists()) {
        continue;
      }
      const byOrg = snap.val() as Record<string, Record<string, Customer>>;

      for (const [orgId, customers] of Object.entries(byOrg)) {
        // The org's active admins and brand are read at most once per org, and
        // only when a customer in it actually expired today.
        let admins: Array<{ uid: string; email?: string }> | null = null;
        let orgName: string | null = null;
        let orgBrand: EmailBrand | null = null;

        for (const [customerId, customer] of Object.entries(customers ?? {})) {
          const endDate = customer?.contractEndDate;
          if (
            customer?.status !== 'active' ||
            typeof endDate !== 'number' ||
            utcDayNumber(endDate) >= today
          ) {
            continue;
          }

          // ONE atomic update: the archive, the access withdrawal and the audit
          // entry cannot come apart. The actor is the platform itself - no
          // person pressed this - which the console renders as an automation
          // rather than looking a uid up in the staff directory.
          const customerPath = paths.db.customer(orgId, customerId);
          const update: Record<string, unknown> = {
            [`${customerPath}/status`]: 'archived',
            ...(await portalAccessCascade(paths, orgId, customerId, 'lock')),
            ...activityUpdate(paths, orgId, {
              actorUid: SYSTEM_ACTOR_UID,
              action: 'customer.contractEnded',
              target: customerId,
            }),
          };
          await db.ref().update(update);
          archived += 1;

          if (admins === null) {
            const membersSnap = await db.ref(paths.db.orgMembers(orgId)).get();
            const members =
              (membersSnap.val() as Record<string, OrgMember> | null) ?? {};
            admins = Object.entries(members)
              .filter(
                ([, member]) =>
                  member?.status === 'active' && member.roles?.admin === true,
              )
              .map(([uid, member]) => ({ uid, email: member.email }));
            const profileSnap = await db.ref(paths.db.orgProfile(orgId)).get();
            const profile = profileSnap.val() as OrgProfile | null;
            orgName = profile?.name ?? 'Your organisation';
            orgBrand = orgEmailBrand(profile);
          }

          const customerName = customer.name ?? customerId;
          const body = `The contract with ${customerName} ended on ${formatDate(
            endDate,
          )}. They have been archived and their portal access has been withdrawn.`;
          const subject = `Contract ended: ${customerName}`;
          const html = renderBrandedEmail({
            brand: orgBrand ?? undefined,
            preheader: body,
            heading: `${orgName}: a customer contract has ended`,
            paragraphs: [
              body,
              'Their sites, buildings and assessment history are unchanged and stay in your records. Restore the customer if the contract has been renewed - that returns the portal access this withdrew.',
            ],
            detailRows: [
              { label: 'Customer', value: customerName },
              { label: 'Contract ended', value: formatDate(endDate) },
            ],
            cta: {
              label: 'View the customer',
              url: `${WEB_ORIGIN}/app/customers/${customerId}`,
            },
            footerNote: `You are receiving this because you are an administrator of ${orgName} on Safentia.`,
          });

          for (const admin of admins) {
            // This is an account-state change the organisation MUST know about -
            // access has been withdrawn on their behalf - so it is not one of
            // the quietenable categories a member can switch off, in the same
            // way the overdue review notice always sends.
            await sendNotification(
              paths,
              orgId,
              admin.uid,
              { type: 'account', title: 'Customer contract ended', body },
              logger,
            );
            if (admin.email) {
              await dispatchEmail({ to: admin.email, subject, body, html }, logger, {
                orgId,
                env,
                category: 'contract-ended',
              });
            }
          }
        }
      }
    }

    logger.info('Customer contracts swept', { archived });
  },
);
