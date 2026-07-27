// ============================================================================
// reviewReminders (scheduled) - FRA-review due-date reminders (story 2046).
//
// Every morning at 07:30 UK time we look across both environment roots and, for
// every organisation's buildings, check the fire-risk-assessment review date
// (serviceSchedule.fraReview.nextDue). A building whose review falls exactly
// 60, 30 or 7 days ahead - or whose due day fully passed yesterday ("lapsed") -
// earns ONE notice: an in-app notification (plus best-effort push) to each of
// the org's active admins, and one branded email to each admin's address.
//
// Idempotency: the day-matching is exact-day, so a scheduler redelivery the
// same day would duplicate every notice. A transaction claims the per-building
// per-day marker under /{env}/ops/reviewReminders/{orgId}/{buildingId}/{day}
// (the ops tree is server-only; the root template follows the established
// dailyJobReminders precedent) before anything is sent.
//
// Scale posture: one /{env}/buildings read per env, then in-memory walking of
// orgs -> sites -> buildings, with org member lists and profiles read once per
// org that actually has a match. Linear in estate size - comfortably fine at
// the platform's current scale; revisit with per-org fan-out if orgs grow to
// thousands.
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
import {
  reviewReminderStage,
  resolveReviewReminderDays,
  utcDayKey,
  type ReminderStage,
} from '../lib/reviewWindows';
import type {
  Building,
  CustomerContact,
  Environment,
  OrgMember,
  OrgProfile,
  OrgSettings,
} from '../shared/types';

const ENVIRONMENTS: Environment[] = ['live', 'test'];

/** The due date rendered for the email, in UTC so it names the stored day. */
function formatDueDate(millis: number): string {
  return new Date(millis).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** One line of calm copy per stage, shared by notification and email. */
function stageCopy(stage: ReminderStage, buildingName: string): string {
  if (stage === 'lapsed') {
    return `The fire risk assessment review for ${buildingName} is now overdue.`;
  }
  return `The fire risk assessment review for ${buildingName} is due in ${stage} days.`;
}

export const reviewReminders = onSchedule(
  {
    schedule: '30 7 * * *',
    timeZone: 'Europe/London',
    region: REGION,
    secrets: EMAIL_PROVIDER_SECRETS,
  },
  async () => {
    const logger = createLogger({ fn: 'reviewReminders' });
    const now = Date.now();
    const today = utcDayKey(now);
    let notices = 0;

    for (const env of ENVIRONMENTS) {
      const paths = forEnv(env);
      // One read of the env's buildings tree: { orgId: { siteId: { buildingId } } }.
      const snap = await db.ref(`${env}/buildings`).get();
      if (!snap.exists()) {
        continue;
      }
      const byOrg = snap.val() as Record<
        string,
        Record<string, Record<string, Building>>
      >;

      for (const [orgId, sites] of Object.entries(byOrg)) {
        // Story 2046 AC1: the reminder schedule is org-configurable, and it
        // decides which buildings match today, so it must be resolved BEFORE
        // the building walk - it cannot be read lazily on first match the way
        // admins/profile are. One settings read per org (not per building) keeps
        // the sweep linear; a malformed or absent config repairs to the built-in
        // default rather than skipping or crashing the org.
        const settingsSnap = await db.ref(paths.db.orgSettings(orgId)).get();
        const settings = settingsSnap.val() as OrgSettings | null;
        const reminderDays = resolveReviewReminderDays(
          settings?.reviewReminderDays,
        );
        // The largest (earliest) mark is the "planning noise" one withheld from
        // customers; with the default schedule this is the 60-day mark, as
        // before. Element zero because the schedule is validated descending.
        const farthestMark = reminderDays[0];

        // The org's active admins and display name are read at most once per
        // org, and only when a building in it actually matched today.
        let admins: Array<{
          uid: string;
          email?: string;
          emailReviewDue: boolean;
        }> | null = null;
        let orgName: string | null = null;
        // Each org's reminder emails carry ITS own brand (name + accent), so a
        // multi-org sweep brands every message with the organisation it concerns,
        // falling back to the Safentia brand when an org has not set a valid one.
        let orgBrand: EmailBrand | null = null;

        // Entries, not values: the CTA below deep-links to the building, whose
        // console route carries the site it sits under.
        for (const [siteId, buildings] of Object.entries(sites ?? {})) {
          for (const [buildingId, building] of Object.entries(buildings ?? {})) {
            const nextDue = building?.serviceSchedule?.fraReview?.nextDue;
            if (typeof nextDue !== 'number') {
              continue;
            }
            const stage = reviewReminderStage(nextDue, now, reminderDays);
            if (stage === null) {
              continue;
            }

            // Idempotency: claim the per-building per-day marker; if another
            // run already holds it, this delivery is a duplicate - skip.
            const marker = db.ref(
              `${env}/ops/reviewReminders/${orgId}/${buildingId}/${today}`,
            );
            const claim = await marker.transaction((current) =>
              current ? undefined : true,
            );
            if (!claim.committed) {
              continue;
            }

            if (admins === null) {
              const membersSnap = await db.ref(paths.db.orgMembers(orgId)).get();
              const members =
                (membersSnap.val() as Record<string, OrgMember> | null) ?? {};
              admins = Object.entries(members)
                .filter(
                  ([, member]) =>
                    member?.status === 'active' && member.roles?.admin === true,
                )
                .map(([uid, member]) => ({
                  uid,
                  email: member.email,
                  // Story 2066: the email (only) is quietened by the member's
                  // own preference; absent means on, so only an explicit false
                  // skips. The in-app notification always sends.
                  emailReviewDue: member.emailPreferences?.reviewDue !== false,
                }));
              const profileSnap = await db.ref(paths.db.orgProfile(orgId)).get();
              const profile = profileSnap.val() as OrgProfile | null;
              orgName = profile?.name ?? 'Your organisation';
              orgBrand = orgEmailBrand(profile);
            }

            const buildingName = building.name ?? buildingId;
            const body = stageCopy(stage, buildingName);
            const subject =
              stage === 'lapsed'
                ? `FRA review overdue: ${buildingName}`
                : `FRA review due in ${stage} days: ${buildingName}`;
            const html = renderBrandedEmail({
              brand: orgBrand ?? undefined,
              preheader: body,
              // The org's name leads the heading so a multi-org admin knows
              // whose estate this concerns before reading further.
              heading: `${orgName}: fire risk assessment review`,
              paragraphs: [
                body,
                'Reviews keep the assessment current; please arrange the review before the due date passes.',
              ],
              detailRows: [
                { label: 'Building', value: buildingName },
                { label: 'Review due', value: formatDueDate(nextDue) },
                {
                  label: 'Days remaining',
                  value: stage === 'lapsed' ? 'Overdue' : `${stage} days`,
                },
              ],
              // Straight to the building's record, where the service schedule
              // that raised this reminder is edited.
              cta: {
                label: 'View the building',
                url: `${WEB_ORIGIN}/app/customers/${building.customerId}/sites/${siteId}/buildings/${buildingId}`,
              },
              footerNote: `You are receiving this because you are an administrator of ${orgName} on Safentia.`,
            });

            for (const admin of admins) {
              // ONE in-app notification (plus best-effort push) per admin...
              await sendNotification(
                paths,
                orgId,
                admin.uid,
                {
                  type: 'reminder',
                  title:
                    stage === 'lapsed' ? 'FRA review overdue' : 'FRA review due',
                  body,
                },
                logger,
              );
              // ...and one branded email, unless the admin quietened the
              // review-due category. Best-effort by design: dispatchEmail
              // never throws, so a provider outage cannot abort the sweep.
              if (admin.email && admin.emailReviewDue) {
                await dispatchEmail(
                  { to: admin.email, subject, body, html },
                  logger,
                  { orgId, env, category: 'review-reminder' },
                );
              }
            }

            // Story 2060: the customer hears about their review too, at the
            // NEARER approach marks and when it has LAPSED. Every customer
            // contact with an email is told, not just the primary. The
            // FARTHEST (earliest) mark is deliberately withheld from the
            // customer: the earliest reminder is planning noise to a duty-
            // holder, whereas the near marks and the overdue notice are the
            // ones they need to see. With the default schedule this is the
            // 60-day mark, as before; with a configured schedule it is whatever
            // the org set as its earliest offset. Contacts have no preferences node
            // (emailPreferences is an OrgMember field), so there is no choice
            // to respect yet; revisit with portal settings.
            //
            // Idempotency: this block sits INSIDE the per-building per-day
            // marker claimed above, and a building earns exactly one stage per
            // day, so a scheduler redelivery cannot reach here twice - each
            // contact is emailed at most once per stage per day without a
            // second marker node.
            if (stage !== farthestMark && building.customerId) {
              const contactsSnap = await db
                .ref(paths.db.customerContacts(orgId, building.customerId))
                .get();
              const contacts =
                (contactsSnap.val() as Record<string, CustomerContact> | null) ??
                {};
              const customerSubject =
                stage === 'lapsed'
                  ? `FRA review overdue: ${buildingName}`
                  : `FRA review due in ${stage} days: ${buildingName}`;
              const customerBody =
                stage === 'lapsed'
                  ? `The fire risk assessment review for ${buildingName} is now overdue. Please contact ${orgName ?? 'your fire safety provider'} to arrange the review.`
                  : `The fire risk assessment review for ${buildingName} is due in ${stage} days. ${orgName ?? 'Your fire safety provider'} arranges this; there is nothing you need to do unless they ask you to.`;
              // The message is the same for every contact, so it is rendered
              // once and sent to each de-duplicated address.
              const customerHtml = renderBrandedEmail({
                brand: orgBrand ?? undefined,
                preheader: customerBody,
                heading:
                  stage === 'lapsed'
                    ? 'Fire risk assessment review overdue'
                    : 'Fire risk assessment review due',
                paragraphs: [customerBody],
                detailRows: [
                  { label: 'Building', value: buildingName },
                  { label: 'Review due', value: formatDueDate(nextDue) },
                ],
                // The customer's own portal building page, never the staff
                // console - the console would only show them a permission wall.
                cta: {
                  label: 'View your building',
                  url: `${WEB_ORIGIN}/app/sites/${siteId}/buildings/${buildingId}`,
                },
                footerNote: `You are receiving this because you are a contact for ${buildingName} on Safentia.`,
              });
              const seen = new Set<string>();
              for (const contact of Object.values(contacts)) {
                const email = contact?.email?.trim();
                if (!email) {
                  continue;
                }
                // Collapse a person listed twice (or a shared inbox) so no one
                // is emailed twice; the first spelling seen is used to send.
                const key = email.toLowerCase();
                if (seen.has(key)) {
                  continue;
                }
                seen.add(key);
                // Best-effort per recipient: dispatchEmail never throws, so one
                // contact's provider failure cannot abort the sweep.
                await dispatchEmail(
                  {
                    to: email,
                    subject: customerSubject,
                    body: customerBody,
                    html: customerHtml,
                  },
                  logger,
                  { orgId, env, category: 'review-reminder' },
                );
              }
            }
            notices += 1;
          }
        }
      }
    }

    logger.info('Review reminders sent', { buildings: notices });
  },
);
