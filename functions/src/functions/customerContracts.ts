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
// THE TWO CHANNELS COLLAPSE IN DIFFERENT PLACES. Each admin gets ONE in-app
// notice per run covering every contract that ended, because an inbox record
// spends a slot of the org's monthly notification quota and a week of clustered
// renewals could otherwise exhaust it (see the note on `ended`). The EMAILS are
// still sent one per customer: the delivery seam (lib/emailDigest) already holds
// every 'contract-ended' message to one digest per address per day and lists a
// row per customer inside it, so the reader gets one email either way - with the
// per-customer detail kept rather than thrown away here.
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
import { EMAIL_PROVIDER_SECRETS } from '../lib/email';
import { orgEmailBrand, type EmailBrand } from '../lib/emailTemplates';
import { loadKindConfig } from '../lib/templatedEmail';
import { deliverKindEmail } from '../lib/emailDigest';
import { portalAccessCascade } from '../lib/customerAccess';
import { adjustCustomerCount } from '../lib/usageCounters';
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

/** The per-org template resolution the seam returns, read once per org so the
 *  admin fan-out below never re-resolves it. */
type KindConfig = Awaited<ReturnType<typeof loadKindConfig>>;

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
        // The kind's resolved template, read once per org alongside the
        // audience rather than once per customer or per admin.
        let kindConfig: KindConfig | null = null;
        // Every customer this run archived in this org, held until the whole
        // customer walk is done so the admins hear ONCE however many contracts
        // ended together. Renewals cluster - a year's worth signed in the same
        // week ends in the same week - and each in-app notice consumes a slot
        // of the organisation's monthly notification quota, which
        // sendNotification enforces by SILENTLY ABORTING once the cap is
        // reached. A per-customer fan-out could therefore spend a month's quota
        // in one morning and suppress unrelated notices (a submitted
        // assessment, a cancelled job) for weeks afterwards. The admin digest in
        // deadlineReminders' sweepActions is the precedent this follows.
        const ended: Array<{ name: string; endDate: number }> = [];

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

          // Usage accounting (Phase 3 brief 5.2): this archive is the same
          // state change as an admin's, so it moves the same counter. The
          // active-only guard above means it can never decrement twice for the
          // one customer. Best-effort - the archive has already committed.
          await adjustCustomerCount(paths, orgId, -1, logger);

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
            kindConfig = await loadKindConfig(
              env,
              orgId,
              'contract-ended',
              logger,
            );
          }

          const customerName = customer.name ?? customerId;
          // Held for the org's single in-app notice, sent once the customer
          // walk is done (see the note on `ended`).
          ended.push({ name: customerName, endDate });

          // The EMAIL stays per customer. The two channels are collapsed in
          // different places on purpose: an inbox record costs a slot of the
          // org's monthly notification quota and so has to be collapsed here,
          // inside the sweep, whereas an email costs credits and is bundled for
          // us by the delivery seam, which holds every 'contract-ended' message
          // to one digest per address per day and carries a row per customer
          // inside it. Collapsing the email here as well would throw away
          // detail the digest is able to keep. deadlineReminders splits the two
          // channels the same way.
          for (const admin of admins) {
            if (!admin.email) {
              continue;
            }
            await deliverKindEmail(
              {
                kind: 'contract-ended',
                env,
                orgId,
                to: admin.email,
                variables: {
                  'org.name': orgName ?? 'Your organisation',
                  'customer.name': customerName,
                  'contract.endDate': formatDate(endDate),
                },
                // Guaranteed set alongside `admins`; the fallback is the
                // same Safentia default the renderer would choose.
                brand: orgBrand ?? orgEmailBrand(null),
                kindLink: `${WEB_ORIGIN}/app/customers/${customerId}`,
                // This customer's line in a bundled digest: a row in a table,
                // not the sentence the single-customer email already carries.
                digestRow: {
                  label: customerName,
                  value: `Contract ended ${formatDate(endDate)}`,
                },
                config: kindConfig ?? undefined,
              },
              logger,
            );
          }
        }

        // ONE in-app notice per admin for the whole org, however many contracts
        // ended today. `admins` is non-null exactly when at least one did, so
        // an org with nothing expiring has still cost nothing to read.
        if (ended.length === 0 || admins === null) {
          continue;
        }
        // This is an account-state change the organisation MUST know about -
        // access has been withdrawn on their behalf - so no INDIVIDUAL can
        // switch it off: it is not one of the quietenable categories a member's
        // preferences cover, in the same way the overdue review notice always
        // sends. The ORGANISATION, though, can now silence the email kind as a
        // whole: the seam honours the org's 'contract-ended' toggle, which is an
        // intended capability of the templating seam, not a per-member
        // preference.
        //
        // A single ending keeps the wording it has always had, so the common
        // case reads exactly as before; several collapse to a count, because
        // naming five customers in a notification body is a list nobody reads
        // in an inbox row.
        const body =
          ended.length === 1
            ? `The contract with ${ended[0].name} ended on ${formatDate(
                ended[0].endDate,
              )}. They have been archived and their portal access has been withdrawn.`
            : `${ended.length} customer contracts have ended. Those customers have been archived and their portal access withdrawn.`;
        for (const admin of admins) {
          await sendNotification(
            paths,
            orgId,
            admin.uid,
            {
              type: 'account',
              title:
                ended.length === 1
                  ? 'Customer contract ended'
                  : 'Customer contracts ended',
              body,
            },
            logger,
          );
        }
      }
    }

    logger.info('Customer contracts swept', { archived });
  },
);
