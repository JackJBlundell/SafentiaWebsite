// ============================================================================
// reviewReminders (scheduled) - FRA-review due-date reminders (story 2046).
//
// Every morning at 07:30 UK time we look across both environment roots and, for
// every organisation's buildings, check the fire-risk-assessment review date
// (serviceSchedule.fraReview.nextDue). A building whose review falls exactly
// 60, 30 or 7 days ahead - or whose due day fully passed yesterday ("lapsed") -
// earns ONE notice: one branded email to each of the org's active admins, plus
// (at the nearer marks) one to every contact of the customer that owns it, and
// a place in the single in-app notification the org's admins receive.
//
// THE TWO CHANNELS COLLAPSE IN DIFFERENT PLACES, deliberately. The IN-APP notice
// is one per admin per RUN, covering every building that matched, not one per
// building: each in-app notice spends a slot of the organisation's monthly
// notification quota, which sendNotification enforces by SILENTLY ABORTING
// everything past the cap, so a large estate on a ladder day could burn a whole
// month's quota in one morning and suppress unrelated notices (a submitted
// assessment, a cancelled job) for weeks afterwards. The estate walk therefore
// accumulates its matches and tells each admin once at the end - the pattern
// deadlineReminders' sweepActions established, for exactly this reason. The
// EMAILS stay one per building: they cost credits rather than quota, and the
// delivery seam (lib/emailDigest) already holds every message of one kind to one
// digest per address per day, carrying a row per building inside it. Collapsing
// them here as well would only discard detail the digest is able to keep.
//
// WHO IS IN SCOPE: the organisation's master switch (OrgSettings
// .reviewRemindersEnabled) can stop the sweep for a whole org; an ARCHIVED
// customer's buildings are skipped entirely, because their portal access has
// already been withdrawn and reminding them about a review would undo the point
// of archiving them. There is deliberately no per-customer mute: an ACTIVE
// customer is one you are accountable to, and a switch that silently stops
// telling a duty-holder their assessment is due is the last thing anyone wants
// to explain afterwards. Archiving is how a relationship ends.
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
import { EMAIL_PROVIDER_SECRETS } from '../lib/email';
import { orgEmailBrand, type EmailBrand } from '../lib/emailTemplates';
import { loadKindConfig } from '../lib/templatedEmail';
import { deliverKindEmail } from '../lib/emailDigest';
import {
  reviewReminderStage,
  resolveReviewReminderDays,
  utcDayKey,
  type ReminderStage,
} from '../lib/reviewWindows';
import type {
  Building,
  Customer,
  CustomerContact,
  Environment,
  OrgMember,
  OrgProfile,
  OrgSettings,
} from '../shared/types';

const ENVIRONMENTS: Environment[] = ['live', 'test'];

/** The per-org template resolution the seam returns, read once per (org, kind)
 *  so the building fan-out below never re-resolves it. */
type KindConfig = Awaited<ReturnType<typeof loadKindConfig>>;

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
        // The org's master switch. Absent means on, so an org that has never
        // opened the setting keeps the reminders it already had; an explicit
        // false stops the whole sweep for this organisation, overdue notices
        // included - it is the "stop emailing about reviews" switch, and a
        // half-off version of it would be a lie.
        if (settings?.reviewRemindersEnabled === false) {
          continue;
        }
        const reminderDays = resolveReviewReminderDays(
          settings?.reviewReminderDays,
        );
        // One read of the org's customer directory, so each building can be
        // checked against the customer that owns it. An ARCHIVED customer is no
        // longer a customer: their people's portal access has been withdrawn
        // (manageCustomer's cascade), and emailing them about an FRA review
        // afterwards is the exact confusion archiving is supposed to end. The
        // org's own admins are not notified about them either - the estate is
        // still in the records to read, it just no longer earns a daily nudge.
        const customersSnap = await db.ref(paths.db.customers(orgId)).get();
        const customers =
          (customersSnap.val() as Record<string, Customer> | null) ?? {};
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
        // The resolved templates for the two kinds this sweep sends, each read
        // once per org (never per building or per recipient) - these loops are
        // fan-outs, and the seam accepts the resolution back as `config`.
        let adminConfig: KindConfig | null = null;
        let contactConfig: KindConfig | null = null;
        // Every building in this org that matched today, held until the whole
        // estate has been walked so the admins are told ONCE rather than once
        // per building. See the header note on the two channels for why the
        // in-app side collapses here while the emails below do not.
        const matched: Array<{
          buildingName: string;
          stage: ReminderStage;
          nextDue: number;
        }> = [];

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
            // Checked BEFORE the idempotency marker is claimed: a skipped
            // building must not burn its marker for the day, or restoring the
            // customer mid-morning would silently cost them that day's notice.
            const customer = building.customerId
              ? customers[building.customerId]
              : undefined;
            if (customer && customer.status !== 'active') {
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
              adminConfig = await loadKindConfig(
                env,
                orgId,
                'review-reminder-admin',
                logger,
              );
            }

            const buildingName = building.name ?? buildingId;
            // The seam owns the rendering now; what it needs from here are the
            // exact phrases this sweep has always computed, supplied as the
            // catalogue's declared variables.
            const subjectPhrase =
              stage === 'lapsed'
                ? 'FRA review overdue'
                : `FRA review due in ${stage} days`;
            const bodyStagePhrase =
              stage === 'lapsed' ? 'now overdue' : `due in ${stage} days`;
            // This building's line when the seam bundles a recipient's day into
            // one digest: a row in a table, not a sentence. Shared by both kinds
            // because an admin and a duty-holder reading about the same building
            // on the same morning should see the same row.
            const digestRow = {
              label: buildingName,
              value:
                stage === 'lapsed'
                  ? `Review overdue (due ${formatDueDate(nextDue)})`
                  : `Due ${formatDueDate(nextDue)} — ${stage} days`,
            };

            // Held for the org's single in-app notice, sent once the estate
            // walk is done (see the note on `matched`).
            matched.push({ buildingName, stage, nextDue });

            for (const admin of admins) {
              // One branded email per admin per building, unless the admin
              // quietened the review-due category. Best-effort by design:
              // deliverKindEmail never throws, so a provider outage cannot abort
              // the sweep - and it decides for itself whether this message goes
              // out now or joins the admin's next daily digest.
              if (admin.email && admin.emailReviewDue) {
                await deliverKindEmail(
                  {
                    kind: 'review-reminder-admin',
                    env,
                    orgId,
                    to: admin.email,
                    variables: {
                      'org.name': orgName ?? 'Your organisation',
                      'building.name': buildingName,
                      'review.subjectPhrase': subjectPhrase,
                      'review.stagePhrase': bodyStagePhrase,
                      'review.dueDate': formatDueDate(nextDue),
                      'review.daysRemaining':
                        stage === 'lapsed' ? 'Overdue' : `${stage} days`,
                    },
                    // Guaranteed set alongside `admins`; the fallback is the
                    // same Safentia default the renderer would choose.
                    brand: orgBrand ?? orgEmailBrand(null),
                    // Straight to the building's record, where the service
                    // schedule that raised this reminder is edited.
                    kindLink: `${WEB_ORIGIN}/app/customers/${building.customerId}/sites/${siteId}/buildings/${buildingId}`,
                    digestRow,
                    config: adminConfig ?? undefined,
                  },
                  logger,
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
              const customerBody =
                stage === 'lapsed'
                  ? `The fire risk assessment review for ${buildingName} is now overdue. Please contact ${orgName ?? 'your fire safety provider'} to arrange the review.`
                  : `The fire risk assessment review for ${buildingName} is due in ${stage} days. ${orgName ?? 'Your fire safety provider'} arranges this; there is nothing you need to do unless they ask you to.`;
              if (contactConfig === null) {
                contactConfig = await loadKindConfig(
                  env,
                  orgId,
                  'review-reminder-contact',
                  logger,
                );
              }
              // The message is the same for every contact, so its variables are
              // computed once and sent to each de-duplicated address.
              const contactVariables = {
                'building.name': buildingName,
                'review.subjectPhrase': subjectPhrase,
                'review.headingPhrase':
                  stage === 'lapsed'
                    ? 'Fire risk assessment review overdue'
                    : 'Fire risk assessment review due',
                'review.bodyText': customerBody,
                'review.dueDate': formatDueDate(nextDue),
              };
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
                // Best-effort per recipient: deliverKindEmail never throws, so
                // one contact's provider failure cannot abort the sweep.
                await deliverKindEmail(
                  {
                    kind: 'review-reminder-contact',
                    env,
                    orgId,
                    to: email,
                    variables: contactVariables,
                    brand: orgBrand ?? orgEmailBrand(null),
                    // The customer's own portal building page, never the staff
                    // console - the console would only show them a permission
                    // wall.
                    kindLink: `${WEB_ORIGIN}/app/sites/${siteId}/buildings/${buildingId}`,
                    digestRow,
                    config: contactConfig,
                  },
                  logger,
                );
              }
            }
            notices += 1;
          }
        }

        // ONE in-app notice per admin for the whole org, however many buildings
        // matched today. `admins` is non-null exactly when at least one did, so
        // an org with nothing due has still cost nothing beyond its settings and
        // customer reads. Every building here already holds its own per-day
        // marker, claimed in the walk above, so a scheduler redelivery finds
        // nothing to accumulate and sends no second notice.
        if (matched.length === 0 || admins === null) {
          continue;
        }
        const overdue = matched.filter((item) => item.stage === 'lapsed').length;
        // A single match keeps today's exact wording, so the common case reads
        // precisely as it always has; several collapse to a count, because
        // naming forty buildings in a notification body is a list nobody reads
        // from an inbox row. The same one-versus-many shape sweepActions uses.
        const summary =
          matched.length === 1
            ? stageCopy(matched[0].stage, matched[0].buildingName)
            : `${matched.length} buildings need a fire risk assessment review${overdue > 0 ? `, ${overdue} of them overdue` : ''}.`;
        const title =
          matched.length > 1
            ? 'FRA reviews due'
            : matched[0].stage === 'lapsed'
              ? 'FRA review overdue'
              : 'FRA review due';
        for (const admin of admins) {
          await sendNotification(
            paths,
            orgId,
            admin.uid,
            { type: 'reminder', title, body: summary },
            logger,
          );
        }
      }
    }

    logger.info('Review reminders sent', { buildings: notices });
  },
);
