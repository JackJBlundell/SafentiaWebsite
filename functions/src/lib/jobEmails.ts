// ============================================================================
// Visit emails - the branded twin of the in-app job notifications, for the two
// people a booking concerns: the ASSESSOR whose diary it lands in, and the
// CUSTOMER whose building is being visited.
//
// createJob, rescheduleJob, cancelJob and the 07:00 dailyJobReminders digest all
// raise an in-app notification (plus a best-effort push). This module adds the
// EMAIL that sits beside it, so an assessor who has not opened the app that day
// still learns their diary changed - the courtesy auditors, admins and customers
// already had. The notification is untouched: the email is additional, never a
// replacement, which is also why the member's opt-out silences only the email.
//
// The customer side (sendVisitCustomerEmails, below) closes the other half of
// the gap: until it existed, "someone is coming on Tuesday" - the single most
// expected message in this whole category - was never sent to the duty-holder
// at all, and the first they knew of a visit was an assessor at reception.
// Every contact of the customer with an address hears about the booking, the
// move and the cancellation, in duty-holder language rather than diary language.
//
// The COPY no longer lives here: each change is an EmailKindId whose default
// wording sits in lib/emailKindCatalogue (verbatim what this module used to
// hardcode), and lib/templatedEmail resolves the org's assigned template over
// that default, renders it and dispatches. This module supplies the FACTS -
// the catalogue-declared {{variables}}, the detail rows and the per-recipient
// CTA link - and the recipient plumbing (preferences, de-duplication, portal
// accounts) that no template can know.
//
// Everything here is BEST-EFFORT, deliberately: three of the four senders run
// from a callable's request path AFTER the business write has committed, so a
// slow provider or a missing customer record must not turn a successful
// reschedule into an error the admin will retry (sendKindEmail never throws by
// contract; the reads around it are wrapped to hold the same promise).
// ============================================================================

import { db } from '../admin';
import { WEB_ORIGIN } from './webOrigin';
import { loadKindConfig, sendKindEmail } from './templatedEmail';
import {
  orgEmailBrand,
  type EmailBrand,
  type EmailDetailRow,
} from './emailTemplates';
import type { Logger } from './logging';
import type { EnvPaths } from '../shared/paths';
import type {
  Customer,
  CustomerContact,
  CustomerMember,
  EmailKindId,
  OrgMember,
  OrgProfile,
  Site,
} from '../shared/types';

/** Every diary email says the same thing about why it arrived and where the
 *  switch is, so the line is written once. */
export const JOB_EMAIL_FOOTER =
  'You are receiving this because these visits are in your Safentia diary. You can turn job emails off in your account settings.';

/** Full date for the detail card, on the Europe/London clock the assessor works
 *  to - the same wall clock lib/ukCalendar uses for the notification copy. */
const DATE_LABEL = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

/** 24-hour time for slotted visits, e.g. '09:00'. */
const TIME_LABEL = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/**
 * The visit's day, with its slot when it has one. An email is read hours or days
 * after it lands, so it names the full date rather than the notification's
 * relative 'today' - which would be a lie by tomorrow morning.
 */
export function formatVisitDate(
  scheduledFor: number,
  scheduledUntil?: number,
): string {
  const day = DATE_LABEL.format(new Date(scheduledFor));
  return scheduledUntil === undefined
    ? day
    : `${day}, ${formatVisitTime(scheduledFor, scheduledUntil)}`;
}

/** Just the slot, for the digest's per-visit rows. Date-only jobs carry no time
 *  of day - naming one would invent precision the admin never set. */
export function formatVisitTime(
  scheduledFor: number,
  scheduledUntil?: number,
): string {
  return scheduledUntil === undefined
    ? 'No set time'
    : `${TIME_LABEL.format(new Date(scheduledFor))}–${TIME_LABEL.format(new Date(scheduledUntil))}`;
}

/** Where a diary email goes and what brand it wears. */
export interface JobEmailRecipient {
  email: string;
  brand: EmailBrand;
}

/**
 * Resolve the assessor's address and their organisation's brand, or null when
 * there is no one to email.
 *
 * Three reasons to send nothing: the member has no address, the member is no
 * longer active (a locked account's diary is not theirs to travel to), or they
 * quietened the category. ABSENT means on - only an explicit false silences,
 * which is the EmailPreferences contract the whole platform shares.
 */
export async function jobEmailRecipient(
  paths: EnvPaths,
  orgId: string,
  assessorUid: string,
): Promise<JobEmailRecipient | null> {
  const memberSnap = await db.ref(paths.db.orgMember(orgId, assessorUid)).get();
  const member = memberSnap.val() as OrgMember | null;
  if (
    !member?.email ||
    member.status !== 'active' ||
    member.emailPreferences?.jobScheduled === false
  ) {
    return null;
  }
  // Each organisation's mail carries ITS own name and accent, falling back to
  // the Safentia brand when the org has not set a valid one.
  const profileSnap = await db.ref(paths.db.orgProfile(orgId)).get();
  return {
    email: member.email,
    brand: orgEmailBrand(profileSnap.val() as OrgProfile | null),
  };
}

/** The facts every diary email carries, whatever changed. */
interface JobChangeEmailBase {
  jobId: string;
  buildingName: string;
  /** Resolved to the customer's name here, so the three senders need not each
   *  carry a read that is only ever used for one line of the detail card. */
  customerId?: string;
  scheduledFor: number;
  scheduledUntil?: number;
  /** The date row's label. A cancelled visit was scheduled; it no longer is. */
  dateLabel?: string;
}

/**
 * One visit's worth of email: which kind of change, and the phrases the
 * catalogue declares that kind's send site supplies (the variance the caller
 * alone can compute - today-vs-future, moved-vs-reassigned). Everything else
 * about the wording lives in the kind's template.
 */
export type JobChangeEmail =
  | (JobChangeEmailBase & {
      kind: 'job-assigned';
      /** 'New job today' or 'New job assigned'. */
      subjectPhrase: string;
      /** 'A new job in your diary today' or 'A new job in your diary'. */
      headingPhrase: string;
    })
  | (JobChangeEmailBase & {
      kind: 'job-rescheduled';
      /** 'Job rescheduled', 'Job moved to today', 'Job assigned to you' or
       *  'Job reassigned'. */
      subjectPhrase: string;
      /** 'Your job has been rescheduled', 'A job has moved to your diary' or
       *  'A job has left your diary'. */
      headingPhrase: string;
      /** The whole lead sentence, exactly as the caller computes it for the
       *  variant being sent (moved, reassigned to, reassigned away). */
      changeSummary: string;
    })
  | (JobChangeEmailBase & {
      kind: 'job-cancelled';
      /** The admin's own words, when any were given. */
      cancellationReason?: string;
    });

/** The catalogue-declared {{variables}} for a diary email, from the facts the
 *  caller supplied. Each arm mirrors its EMAIL_KINDS entry exactly. */
function jobChangeVariables(message: JobChangeEmail): Record<string, string> {
  switch (message.kind) {
    case 'job-assigned':
      return {
        'building.name': message.buildingName,
        'job.subjectPhrase': message.subjectPhrase,
        'job.headingPhrase': message.headingPhrase,
        'visit.date': formatVisitDate(message.scheduledFor, message.scheduledUntil),
      };
    case 'job-rescheduled':
      return {
        'building.name': message.buildingName,
        'job.subjectPhrase': message.subjectPhrase,
        'job.headingPhrase': message.headingPhrase,
        'job.changeSummary': message.changeSummary,
      };
    case 'job-cancelled':
      return {
        'building.name': message.buildingName,
        // The reason travels as an omit-if-empty paragraph, so 'no reason
        // given' is the empty string rather than a missing variable.
        'job.cancellationReason': message.cancellationReason ?? '',
      };
  }
}

/**
 * Send one assessor the branded email for a single visit's assignment, move or
 * cancellation. Silent when the recipient has opted out or cannot be resolved;
 * never throws, so the caller's committed write is safe whatever the provider,
 * the estate records or the network are doing.
 */
export async function sendJobChangeEmail(
  paths: EnvPaths,
  orgId: string,
  assessorUid: string,
  message: JobChangeEmail,
  logger: Logger,
): Promise<void> {
  try {
    const recipient = await jobEmailRecipient(paths, orgId, assessorUid);
    if (!recipient) {
      return;
    }

    const detailRows: EmailDetailRow[] = [
      { label: 'Building', value: message.buildingName },
    ];
    if (message.customerId) {
      const nameSnap = await db
        .ref(paths.db.customer(orgId, message.customerId))
        .child('name')
        .get();
      const customerName = nameSnap.val();
      // A customer that has since been deleted simply drops the row rather than
      // printing an id at someone.
      if (typeof customerName === 'string' && customerName.trim() !== '') {
        detailRows.push({ label: 'Customer', value: customerName });
      }
    }
    detailRows.push({
      label: message.dateLabel ?? 'Scheduled for',
      value: formatVisitDate(message.scheduledFor, message.scheduledUntil),
    });

    await sendKindEmail(
      {
        kind: message.kind,
        env: paths.env,
        orgId,
        to: recipient.email,
        variables: jobChangeVariables(message),
        brand: recipient.brand,
        // The console's job page: the assessor's own view of this work, and
        // the one route that works on whatever device the email is opened on
        // (the notification carries the safentia:// deep link for phones).
        kindLink: `${WEB_ORIGIN}/app/jobs/${message.jobId}`,
        kindRows: detailRows,
      },
      logger,
    );
  } catch (error) {
    logger.warn('Job email failed', {
      jobId: message.jobId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// ----------------------------------------------------------------------------
// The customer's half: telling the duty-holder about their own visit.
// ----------------------------------------------------------------------------

/** Which change the customer is being told about. The kind's template, the date
 *  row's label and the send category all follow from it, so the three callables
 *  pass the facts and none of the copy - which is what stops the duty-holder
 *  voice drifting into three subtly different versions of itself. */
export type VisitChangeKind =
  | 'scheduled'
  | 'rescheduled'
  /** Same date and time, different assessor: the person expected at reception
   *  changed, which is the only part of a reassignment a customer can see. */
  | 'reassigned'
  | 'cancelled';

/** The detail card's date-row label per change: a cancelled visit was
 *  scheduled, a rescheduled one is NOW scheduled. */
const VISIT_DATE_LABEL: Record<VisitChangeKind, string> = {
  scheduled: 'Scheduled for',
  rescheduled: 'Now scheduled for',
  reassigned: 'Scheduled for',
  cancelled: 'Was scheduled for',
};

/** One visit's worth of customer email: the visit, and what happened to it. */
export interface VisitCustomerEmail {
  jobId: string;
  customerId: string;
  siteId: string;
  buildingId: string;
  buildingName: string;
  /** Resolved to a NAME here, and nothing else about them travels: a contact
   *  needs to know who to expect, not who they are. Optional so a job whose
   *  assessor cannot be read still tells the customer about the visit. */
  assessorUid?: string;
  scheduledFor: number;
  scheduledUntil?: number;
  kind: VisitChangeKind;
  /** The admin's cancellation reason, when one was given. */
  reason?: string;
}

/**
 * The visit for the DETAIL CARD of a customer email: the full day, and the
 * arrival window when the admin set one. A date-only job says so outright -
 * the assessor's "No set time" is diary shorthand, whereas a contact reading a
 * bare date would reasonably infer a morning nobody has promised them. The
 * prose keeps to formatVisitDate, where the note would interrupt the sentence.
 */
export function formatVisitWindow(
  scheduledFor: number,
  scheduledUntil?: number,
): string {
  const day = DATE_LABEL.format(new Date(scheduledFor));
  return scheduledUntil === undefined
    ? `${day} (no set arrival time)`
    : `${day}, ${formatVisitTime(scheduledFor, scheduledUntil)}`;
}

/** 'Rose Court, Meadow Business Park'. One contact often looks after several
 *  similarly named buildings, so the site is what tells them apart; a site that
 *  could not be read simply drops out rather than printing an id at anyone. */
function visitPlace(buildingName: string, siteName?: string): string {
  return siteName ? `${buildingName}, ${siteName}` : buildingName;
}

/**
 * Tell the customer's contacts that a visit to their building has been booked,
 * moved, reassigned or cancelled.
 *
 * Nobody is emailed when the customer is ARCHIVED: their portal access has
 * already been withdrawn (manageCustomer's cascade), and operational mail after
 * that point is the exact confusion archiving exists to end - the same rule
 * reviewReminders applies to its customer notices.
 *
 * Addresses are de-duplicated case-insensitively, so a person listed twice or a
 * shared inbox named on several contacts receives one copy, not three.
 *
 * Never throws: this runs from a callable's request path AFTER the booking or
 * cancellation has committed, so a missing record or an unreachable provider
 * must never turn a successful admin action into an error they will retry.
 * Every path that ends in nobody being emailed says so in the logs, with the
 * org, the job and the reason - "the customer was not told" is otherwise
 * indistinguishable from "the customer had no contacts".
 */
export async function sendVisitCustomerEmails(
  paths: EnvPaths,
  orgId: string,
  message: VisitCustomerEmail,
  logger: Logger,
): Promise<void> {
  // Shared diagnostic context: every early return below is a visit whose
  // duty-holder heard nothing, and each needs to be findable by job.
  const context = {
    orgId,
    jobId: message.jobId,
    customerId: message.customerId,
    kind: message.kind,
  };
  try {
    // 1. The customer decides whether ANY of this is sent. A customer record
    // that has vanished is not treated as archived: the contacts still exist
    // under their id, and withholding a visit notice on a missing parent record
    // would be a silent failure, not a policy - mirroring reviewReminders,
    // which skips only a customer it can read and finds inactive.
    const customerSnap = await db
      .ref(paths.db.customer(orgId, message.customerId))
      .get();
    const customer = customerSnap.val() as Customer | null;
    if (customer && customer.status !== 'active') {
      logger.info('Visit email withheld: customer is not active', {
        ...context,
        status: customer.status,
      });
      return;
    }

    // 2. Every contact with an address, de-duplicated case-insensitively: the
    // first spelling seen is the one used to send.
    const contactsSnap = await db
      .ref(paths.db.customerContacts(orgId, message.customerId))
      .get();
    const contacts =
      (contactsSnap.val() as Record<string, CustomerContact> | null) ?? {};
    const seen = new Set<string>();
    const recipients: Array<{ email: string; uid?: string }> = [];
    for (const contact of Object.values(contacts)) {
      const email = contact?.email?.trim();
      if (!email) {
        continue;
      }
      const key = email.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      recipients.push({ email, uid: contact.uid });
    }
    if (recipients.length === 0) {
      logger.info('Visit email withheld: customer has no contact addresses', {
        ...context,
        contacts: Object.keys(contacts).length,
      });
      return;
    }

    // 3. Context for the copy. The org's own name and accent brand the message,
    // falling back to the Safentia brand when it has not set a valid one.
    const [profileSnap, siteSnap, assessorSnap] = await Promise.all([
      db.ref(paths.db.orgProfile(orgId)).get(),
      db.ref(paths.db.site(orgId, message.customerId, message.siteId)).get(),
      // The NAME only: the rest of a member record (their address, their own
      // email preferences) is nothing a customer's email has any business
      // reading, let alone carrying.
      message.assessorUid
        ? db
            .ref(paths.db.orgMember(orgId, message.assessorUid))
            .child('name')
            .get()
        : Promise.resolve(null),
    ]);
    const profile = profileSnap.val() as OrgProfile | null;
    const brand = orgEmailBrand(profile);
    const orgName = profile?.name?.trim() || 'Your fire safety provider';
    const site = siteSnap.val() as Site | null;
    const siteName =
      typeof site?.name === 'string' && site.name.trim() !== ''
        ? site.name
        : undefined;
    const assessorValue = assessorSnap?.val() as unknown;
    // A member deleted between the booking and the send simply drops the row
    // rather than printing a uid at a contact.
    const assessorName =
      typeof assessorValue === 'string' && assessorValue.trim() !== ''
        ? assessorValue
        : undefined;

    // The catalogue-declared {{variables}} for the visit kinds. The reason is
    // an omit-if-empty paragraph, so 'no reason given' is the empty string.
    const kind: EmailKindId = `visit-${message.kind}`;
    const variables: Record<string, string> = {
      'org.name': orgName,
      'building.name': message.buildingName,
      'visit.place': visitPlace(message.buildingName, siteName),
      'visit.date': formatVisitDate(message.scheduledFor, message.scheduledUntil),
      ...(message.kind === 'cancelled'
        ? { 'visit.cancellationReason': message.reason ?? '' }
        : {}),
    };

    const detailRows: EmailDetailRow[] = [
      { label: 'Building', value: message.buildingName },
    ];
    if (siteName) {
      detailRows.push({ label: 'Site', value: siteName });
    }
    detailRows.push({
      label: VISIT_DATE_LABEL[message.kind],
      value: formatVisitWindow(message.scheduledFor, message.scheduledUntil),
    });
    // Who to expect at reception - the assessor's NAME and nothing else. A
    // cancelled visit has nobody to expect, so the row is dropped there.
    if (assessorName && message.kind !== 'cancelled') {
      detailRows.push({ label: 'Assessor', value: assessorName });
    }

    // 4. The portal CTA is per-recipient: a contact with a live portal account
    // gets the button, and one without gets no button at all rather than a
    // link that walls them at a sign-in they cannot pass. `uid` is set when a
    // contact accepts their portal invitation; their account must also still
    // be active, since a locked one hits the same wall (an archived customer
    // never reaches here - step 1 stopped it).
    const portalUids = recipients
      .map((recipient) => recipient.uid)
      .filter((uid): uid is string => Boolean(uid));
    let activePortalUids = new Set<string>();
    if (portalUids.length > 0) {
      const membersSnap = await db
        .ref(paths.db.customerMembers(orgId, message.customerId))
        .get();
      const members =
        (membersSnap.val() as Record<string, CustomerMember> | null) ?? {};
      activePortalUids = new Set(
        portalUids.filter((uid) => members[uid]?.status === 'active'),
      );
    }

    // 5. Send. The template is resolved ONCE for the whole batch and handed to
    // each send; best-effort per recipient (sendKindEmail never throws), so
    // one contact's provider failure cannot cost the others their notice.
    const config = await loadKindConfig(paths.env, orgId, kind, logger);
    for (const recipient of recipients) {
      const hasPortal =
        recipient.uid !== undefined && activePortalUids.has(recipient.uid);
      await sendKindEmail(
        {
          kind,
          env: paths.env,
          orgId,
          to: recipient.email,
          variables,
          brand,
          ...(hasPortal
            ? {
                // The customer's own portal building page, never the staff
                // console - the console would only show them a permission wall.
                kindLink: `${WEB_ORIGIN}/app/sites/${message.siteId}/buildings/${message.buildingId}`,
              }
            : {}),
          kindRows: detailRows,
          config,
        },
        logger,
      );
    }
    logger.info('Visit emails dispatched to customer contacts', {
      ...context,
      recipients: recipients.length,
    });
  } catch (error) {
    // The booking, move or cancellation has already committed; the customer
    // simply was not told, which is a warning to diagnose, never a failure to
    // hand back to the admin.
    logger.warn('Visit customer emails failed', {
      ...context,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
