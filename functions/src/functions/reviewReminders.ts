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
  utcDayKey,
  type ReminderStage,
} from '../lib/reviewWindows';
import type {
  Building,
  CustomerContact,
  Environment,
  OrgMember,
  OrgProfile,
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
            const stage = reviewReminderStage(nextDue, now);
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

            // Story 2060: the customer hears when the review has LAPSED, via
            // their primary contact when one is recorded with an email. The
            // 60/30/7-day countdown notices are deliberately NOT sent to the
            // customer: arranging the review is the organisation's job, and
            // three advance nudges per building would be noise from a service
            // they do not operate - one honest overdue notice is the signal
            // that matters to the duty-holder. Contacts have no preferences
            // node (emailPreferences is an OrgMember field), so there is no
            // choice to respect yet; revisit with portal settings.
            if (stage === 'lapsed' && building.customerId) {
              const contactsSnap = await db
                .ref(paths.db.customerContacts(orgId, building.customerId))
                .get();
              const contacts =
                (contactsSnap.val() as Record<string, CustomerContact> | null) ??
                {};
              const contactEmail = Object.values(contacts).find(
                (contact) => contact?.isPrimary === true,
              )?.email;
              if (contactEmail) {
                const customerBody = `The fire risk assessment review for ${buildingName} is now overdue. Please contact ${orgName ?? 'your fire safety provider'} to arrange the review.`;
                await dispatchEmail(
                  {
                    to: contactEmail,
                    subject: `FRA review overdue: ${buildingName}`,
                    body: customerBody,
                    html: renderBrandedEmail({
                      brand: orgBrand ?? undefined,
                      preheader: customerBody,
                      heading: 'Fire risk assessment review overdue',
                      paragraphs: [customerBody],
                      detailRows: [
                        { label: 'Building', value: buildingName },
                        { label: 'Review due', value: formatDueDate(nextDue) },
                      ],
                      // The customer's own portal, never the staff console -
                      // the console would only show them a permission wall.
                      cta: {
                        label: 'View your building',
                        url: `${WEB_ORIGIN}/app/sites/${siteId}/buildings/${buildingId}`,
                      },
                      footerNote: `You are receiving this because you are the primary contact for ${buildingName} on Safentia.`,
                    }),
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
