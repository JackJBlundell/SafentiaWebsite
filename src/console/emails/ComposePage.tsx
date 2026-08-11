// ============================================================================
// ComposePage - the manual send (section 6b): an administrator picks one of
// the organisation's own templates, chooses who receives it, fills in the
// template's free variables, reviews the rendered email, and sends.
//
// A manual send is an explicit act, so it requires an ORG template - there is
// no built-in fallback copy here (the callable enforces the same). The wizard
// runs on the shared Stepper, with the Variables step skipped entirely when
// the chosen template has none to fill: `org.*` and `recipient.*` tokens are
// server-derived per recipient and never the author's to type (the callable
// rejects spoofed keys), so only what remains is asked for.
//
// Recipients are named BY REFERENCE wherever possible (member uid, customer/
// contact pair) so the server resolves the CURRENT address at send time; only
// an outside address travels raw. The callable caps a send at 50 recipients,
// and the composer holds the same line with a calm notice rather than letting
// the request fail. Results come back one row per recipient with the address
// REDACTED (data minimisation) - shown as-is, outcome by outcome.
// ============================================================================

import { useMemo, useState, type FormEvent } from 'react';
import { Button } from '../../components/Button';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type {
  Customer,
  CustomerContact,
  EmailTemplate,
  ManualEmailRecipient,
  OrgMember,
  SendManualEmailInput,
  SendManualEmailResult,
} from '../../types';
import { Card, CardHeader } from '../ui/Card';
import { EmptyState, ErrorNotice, PageHeader } from '../ui/Page';
import { SkeletonRows } from '../ui/Skeleton';
import { Stepper } from '../ui/Stepper';
import { useCallable } from '../ui/useCallable';
import { isValidEmail, sortByName, toEntries, useOrgScope } from '../customers/shared';
import { extractVariables, renderTemplate } from './emailVariableEngine';
import { renderBrandedEmail } from './emailHtml';
import { EmailsDialog } from './EmailsDialog';
import { useOrgEmailBrand } from './useOrgEmailBrand';
import styles from './ComposePage.module.css';

/** The callable's hard cap, held client-side too so the notice arrives before
 *  the rejection would. */
const MAX_RECIPIENTS = 50;

/** Server-derived variable namespaces: never asked of the author. */
const isServerVariable = (name: string) =>
  name.startsWith('org.') || name.startsWith('recipient.');

/** Every distinct free {{variable}} across a template's text fields, in first-
 *  seen order, minus the server-derived namespaces. */
function freeVariablesOf(template: EmailTemplate): string[] {
  const texts: string[] = [template.subject, template.heading];
  if (template.preheader !== undefined) texts.push(template.preheader);
  if (template.footerNote !== undefined) texts.push(template.footerNote);
  for (const block of template.blocks) {
    if (block.type === 'paragraph') {
      texts.push(block.text);
    } else if (block.type === 'detail-rows') {
      for (const row of block.rows ?? []) {
        texts.push(row.label, row.value);
      }
    } else {
      texts.push(block.label);
      if (block.href !== undefined) texts.push(block.href);
    }
  }
  const names: string[] = [];
  for (const text of texts) {
    for (const name of extractVariables(text)) {
      if (!isServerVariable(name) && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

/** A chosen customer contact, snapshotted at selection time so the review list
 *  still names people after the admin browses to another customer. The send
 *  itself travels by reference - the server resolves the current address. */
interface ChosenContact {
  customerId: string;
  contactId: string;
  name: string;
  email: string;
}

const contactKey = (customerId: string, contactId: string) =>
  `${customerId}/${contactId}`;

/** Calm copy for each per-recipient outcome the callable reports. */
const OUTCOME_COPY: Record<
  SendManualEmailResult['results'][number]['outcome'],
  string
> = {
  sent: 'Sent',
  'skipped-no-provider': 'Skipped - no email provider is configured',
  failed: 'Failed - the provider did not accept it',
  'invalid-recipient': 'Not sent - the recipient could not be resolved',
  duplicate: 'Duplicate of an earlier recipient - not sent twice',
};

export default function ComposePage() {
  const { ready, orgId, db } = useOrgScope();
  const brand = useOrgEmailBrand();
  const send = useCallable<SendManualEmailInput, SendManualEmailResult>(
    'sendManualEmail',
  );

  // --------------------------------------------------------------------------
  // Data - templates always; members/customers from the recipients step on.
  // --------------------------------------------------------------------------
  const templates = useRtdbQuery<Record<string, EmailTemplate> | null>({
    key: keys.emailTemplates(orgId),
    path: db?.emailTemplates(orgId) ?? '',
    enabled: ready,
  });
  const members = useRtdbQuery<Record<string, OrgMember> | null>({
    key: keys.orgMembers(orgId),
    path: db?.orgMembers(orgId) ?? '',
    enabled: ready,
  });
  const customers = useRtdbQuery<Record<string, Customer> | null>({
    key: keys.customers(orgId),
    path: db?.customers(orgId) ?? '',
    enabled: ready,
  });

  // --------------------------------------------------------------------------
  // Wizard state.
  // --------------------------------------------------------------------------
  const [step, setStep] = useState(0);
  const [templateId, setTemplateId] = useState('');
  const [memberSel, setMemberSel] = useState<Record<string, true>>({});
  const [contactSel, setContactSel] = useState<Record<string, ChosenContact>>({});
  const [browsedCustomerId, setBrowsedCustomerId] = useState('');
  const [manualDraft, setManualDraft] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);
  const [manualEmails, setManualEmails] = useState<string[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<SendManualEmailResult | null>(null);

  const contacts = useRtdbQuery<Record<string, CustomerContact> | null>({
    key: keys.customerContacts(orgId, browsedCustomerId),
    path:
      browsedCustomerId !== ''
        ? (db?.customerContacts(orgId, browsedCustomerId) ?? '')
        : '',
    enabled: ready && browsedCustomerId !== '',
  });

  const template = templateId !== '' ? templates.data?.[templateId] : undefined;
  const freeVariables = useMemo(
    () => (template ? freeVariablesOf(template) : []),
    [template],
  );

  // The Variables step exists only when the template leaves something to fill.
  const steps = useMemo(
    () =>
      freeVariables.length > 0
        ? (['Template', 'Recipients', 'Variables', 'Review & send'] as const)
        : (['Template', 'Recipients', 'Review & send'] as const),
    [freeVariables.length],
  );

  // --------------------------------------------------------------------------
  // The combined recipient roll, in send order: staff, contacts, addresses.
  // --------------------------------------------------------------------------
  const memberEntries = useMemo(
    () =>
      sortByName(toEntries(members.data)).filter(
        ([, member]) => member.status === 'active' && isValidEmail(member.email ?? ''),
      ),
    [members.data],
  );
  const chosen = useMemo(() => {
    const roll: Array<{
      key: string;
      name: string;
      email: string;
      recipient: ManualEmailRecipient;
    }> = [];
    for (const [uid, member] of memberEntries) {
      if (memberSel[uid]) {
        roll.push({
          key: `member-${uid}`,
          name: member.name,
          email: member.email,
          recipient: { type: 'member', uid },
        });
      }
    }
    for (const contact of Object.values(contactSel)) {
      roll.push({
        key: `contact-${contactKey(contact.customerId, contact.contactId)}`,
        name: contact.name,
        email: contact.email,
        recipient: {
          type: 'contact',
          customerId: contact.customerId,
          contactId: contact.contactId,
        },
      });
    }
    for (const email of manualEmails) {
      roll.push({
        key: `email-${email}`,
        name: email,
        email,
        recipient: { type: 'email', email },
      });
    }
    return roll;
  }, [memberEntries, memberSel, contactSel, manualEmails]);

  const overCap = chosen.length > MAX_RECIPIENTS;

  // --------------------------------------------------------------------------
  // Handlers.
  // --------------------------------------------------------------------------
  const addManual = (event: FormEvent) => {
    event.preventDefault();
    const email = manualDraft.trim();
    if (!isValidEmail(email)) {
      setManualError('That does not look like an email address.');
      return;
    }
    const duplicate = manualEmails.some(
      (existing) => existing.toLowerCase() === email.toLowerCase(),
    );
    if (duplicate) {
      setManualError('That address is already on the list.');
      return;
    }
    setManualError(null);
    setManualEmails((current) => [...current, email]);
    setManualDraft('');
  };

  const confirmSend = async () => {
    if (!template) {
      return;
    }
    const input: SendManualEmailInput = {
      templateId,
      recipients: chosen.map((entry) => entry.recipient),
    };
    if (freeVariables.length > 0) {
      const supplied: Record<string, string> = {};
      for (const name of freeVariables) {
        supplied[name] = values[name] ?? '';
      }
      input.variables = supplied;
    }
    const result = await send.call(input);
    if (result) {
      setConfirming(false);
      setOutcome(result);
    }
  };

  const reset = () => {
    setStep(0);
    setTemplateId('');
    setMemberSel({});
    setContactSel({});
    setBrowsedCustomerId('');
    setManualDraft('');
    setManualError(null);
    setManualEmails([]);
    setValues({});
    setConfirming(false);
    setOutcome(null);
    send.clearError();
  };

  // --------------------------------------------------------------------------
  // Review rendering - what the FIRST recipient would receive, with the real
  // org name and their name/address standing in for the server-derived pair.
  // --------------------------------------------------------------------------
  const first = chosen[0];
  const previewHtml = useMemo(() => {
    if (!template) {
      return '';
    }
    const variables: Record<string, string> = {
      ...values,
      'org.name': brand.name,
      'recipient.name': first?.name ?? '',
      'recipient.email': first?.email ?? '',
    };
    const rendered = renderTemplate(template, variables, 'preview');
    return renderBrandedEmail({
      brand,
      preheader: rendered.preheader,
      heading: rendered.heading,
      paragraphs: rendered.paragraphs,
      detailRows: rendered.detailRows,
      cta: rendered.cta,
      footerNote: rendered.footerNote ?? '',
    });
  }, [template, values, brand, first]);
  const previewSubject = useMemo(() => {
    if (!template) {
      return '';
    }
    return renderTemplate(
      template,
      {
        ...values,
        'org.name': brand.name,
        'recipient.name': first?.name ?? '',
        'recipient.email': first?.email ?? '',
      },
      'preview',
    ).subject;
  }, [template, values, brand, first]);

  // --------------------------------------------------------------------------
  // Early shells: loading, and the no-templates guide.
  // --------------------------------------------------------------------------
  if (templates.isLoading) {
    return (
      <div className={styles.root}>
        <PageHeader title="Compose" lede="Send one of your templates to the people you choose." />
        <Card>
          <div className={styles.skeletonWrap}>
            <SkeletonRows rows={4} label="Loading your templates" />
          </div>
        </Card>
      </div>
    );
  }

  const templateEntries = sortByName(toEntries(templates.data));
  if (templateEntries.length === 0) {
    return (
      <div className={styles.root}>
        <PageHeader title="Compose" lede="Send one of your templates to the people you choose." />
        <EmptyState
          title="No templates yet"
          body="A manual send starts from one of your organisation's own templates. Create one under Templates, then come back here to send it."
          action={
            <Button variant="secondary" to="/app/emails/templates">
              Go to Templates
            </Button>
          }
        />
      </div>
    );
  }

  // The sent screen replaces the wizard once results are in.
  if (outcome) {
    return (
      <div className={styles.root}>
        <PageHeader title="Compose" lede="Send one of your templates to the people you choose." />
        <div className={styles.stepper}>
          <Stepper steps={steps} current={steps.length} />
        </div>
        <Card>
          <CardHeader
            title="Send complete"
            hint="One line per recipient. Addresses are shown partly hidden by design."
          />
          <ul className={styles.outcomeList}>
            {/* One row per recipient the admin named, in the order they named
                them (the callable's 1:1 contract) - `recipient` is that input
                index, so it is a stable key even when two rows share a
                redacted address. A duplicate row is informational, not a
                failure: the earlier occurrence carries the send outcome. */}
            {outcome.results.map((row) => (
              <li key={row.recipient} className={styles.outcomeRow}>
                <span className={styles.outcomeTo}>{row.to}</span>
                <span
                  className={
                    row.outcome === 'sent'
                      ? styles.outcomeSent
                      : styles.outcomeNotSent
                  }
                >
                  {OUTCOME_COPY[row.outcome]}
                </span>
              </li>
            ))}
          </ul>
          <div className={styles.cardFooter}>
            <Button onClick={reset}>Compose another</Button>
          </div>
        </Card>
      </div>
    );
  }

  // The templates node is live: if the chosen template is deleted mid-flow,
  // every later step would reference nothing, so the wizard falls back to the
  // choice step rather than dead-ending.
  const effectiveStep = template === undefined && step > 0 ? 0 : step;
  const stepName = steps[effectiveStep];

  return (
    <div className={styles.root}>
      <PageHeader title="Compose" lede="Send one of your templates to the people you choose." />
      <div className={styles.stepper}>
        <Stepper steps={steps} current={effectiveStep} />
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Step: Template.                                                  */}
      {/* ---------------------------------------------------------------- */}
      {stepName === 'Template' && (
        <Card>
          <CardHeader
            title="Choose a template"
            hint="The message you send is one of your organisation's own templates, exactly as authored."
          />
          <div className={styles.cardBody}>
            <ul className={styles.templateList}>
              {templateEntries.map(([id, entry]) => (
                <li key={id}>
                  <label className={styles.templateOption}>
                    <input
                      type="radio"
                      name="compose-template"
                      checked={templateId === id}
                      onChange={() => {
                        setTemplateId(id);
                        // A different template means different free variables.
                        setValues({});
                      }}
                    />
                    <span className={styles.templateOptionText}>
                      <span className={styles.templateName}>{entry.name}</span>
                      <span className={styles.templateSubject}>{entry.subject}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
          <div className={styles.cardFooter}>
            <Button disabled={template === undefined} onClick={() => setStep(1)}>
              Next
            </Button>
          </div>
        </Card>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Step: Recipients.                                                */}
      {/* ---------------------------------------------------------------- */}
      {stepName === 'Recipients' && (
        <Card>
          <CardHeader
            title="Choose the recipients"
            hint="Staff and customer contacts are sent to their current address at send time; outside addresses go exactly as typed."
          />
          <div className={styles.cardBody}>
            <section className={styles.recipientSection}>
              <h3 className={styles.sectionTitle}>Your team</h3>
              {members.isError && (
                <ErrorNotice message="The member list could not be loaded. Try again shortly." />
              )}
              {memberEntries.length === 0 && !members.isLoading ? (
                <p className={styles.sectionNote}>
                  No active members with an email address.
                </p>
              ) : (
                <ul className={styles.checkList}>
                  {memberEntries.map(([uid, member]) => (
                    <li key={uid}>
                      <label className={styles.checkItem}>
                        <input
                          type="checkbox"
                          checked={memberSel[uid] === true}
                          onChange={(event) =>
                            setMemberSel((current) => {
                              const next = { ...current };
                              if (event.target.checked) {
                                next[uid] = true;
                              } else {
                                delete next[uid];
                              }
                              return next;
                            })
                          }
                        />
                        <span>
                          {member.name}
                          <span className={styles.checkDetail}> {member.email}</span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className={styles.recipientSection}>
              <h3 className={styles.sectionTitle}>Customer contacts</h3>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Customer</span>
                <select
                  className={styles.select}
                  value={browsedCustomerId}
                  onChange={(event) => setBrowsedCustomerId(event.target.value)}
                >
                  <option value="">Choose a customer</option>
                  {sortByName(toEntries(customers.data)).map(([id, customer]) => (
                    <option key={id} value={id}>
                      {customer.name}
                    </option>
                  ))}
                </select>
              </label>
              {browsedCustomerId !== '' && (
                <>
                  {contacts.isError && (
                    <ErrorNotice message="This customer's contacts could not be loaded. Try again shortly." />
                  )}
                  {(() => {
                    const withEmail = sortByName(toEntries(contacts.data)).filter(
                      ([, contact]) => isValidEmail(contact.email ?? ''),
                    );
                    if (withEmail.length === 0 && !contacts.isLoading) {
                      return (
                        <p className={styles.sectionNote}>
                          This customer has no contacts with an email address.
                        </p>
                      );
                    }
                    return (
                      <ul className={styles.checkList}>
                        {withEmail.map(([contactId, contact]) => {
                          const key = contactKey(browsedCustomerId, contactId);
                          return (
                            <li key={contactId}>
                              <label className={styles.checkItem}>
                                <input
                                  type="checkbox"
                                  checked={contactSel[key] !== undefined}
                                  onChange={(event) =>
                                    setContactSel((current) => {
                                      const next = { ...current };
                                      if (event.target.checked) {
                                        next[key] = {
                                          customerId: browsedCustomerId,
                                          contactId,
                                          name: contact.name,
                                          email: contact.email ?? '',
                                        };
                                      } else {
                                        delete next[key];
                                      }
                                      return next;
                                    })
                                  }
                                />
                                <span>
                                  {contact.name}
                                  <span className={styles.checkDetail}>
                                    {' '}
                                    {contact.email}
                                  </span>
                                </span>
                              </label>
                            </li>
                          );
                        })}
                      </ul>
                    );
                  })()}
                </>
              )}
              {Object.keys(contactSel).length > 0 && (
                <p className={styles.sectionNote}>
                  {Object.keys(contactSel).length} contact
                  {Object.keys(contactSel).length === 1 ? '' : 's'} chosen
                  {browsedCustomerId === '' ? '' : ' across your customers'}.
                </p>
              )}
            </section>

            <section className={styles.recipientSection}>
              <h3 className={styles.sectionTitle}>Other addresses</h3>
              <form className={styles.manualRow} onSubmit={addManual}>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Email address</span>
                  <input
                    type="text"
                    className={styles.input}
                    value={manualDraft}
                    onChange={(event) => {
                      setManualDraft(event.target.value);
                      setManualError(null);
                    }}
                    placeholder="name@example.com"
                  />
                </label>
                <Button type="submit" variant="secondary">
                  Add
                </Button>
              </form>
              {manualError && <ErrorNotice message={manualError} />}
              {manualEmails.length > 0 && (
                <ul className={styles.chipList} aria-label="Added addresses">
                  {manualEmails.map((email) => (
                    <li key={email} className={styles.chip}>
                      <span>{email}</span>
                      <button
                        type="button"
                        className={styles.chipRemove}
                        aria-label={`Remove ${email}`}
                        onClick={() =>
                          setManualEmails((current) =>
                            current.filter((existing) => existing !== email),
                          )
                        }
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <p className={styles.countLine} role="status">
              {chosen.length} recipient{chosen.length === 1 ? '' : 's'} chosen.
            </p>
            {overCap && (
              <p className={styles.capNotice}>
                A single send goes to at most {MAX_RECIPIENTS} recipients. Please
                trim the list, or send in two batches.
              </p>
            )}
          </div>
          <div className={styles.cardFooter}>
            <Button variant="ghost" onClick={() => setStep(0)}>
              Back
            </Button>
            <Button
              disabled={chosen.length === 0 || overCap}
              onClick={() => setStep(2)}
            >
              Next
            </Button>
          </div>
        </Card>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Step: Variables (only when the template has free ones).          */}
      {/* ---------------------------------------------------------------- */}
      {stepName === 'Variables' && (
        <Card>
          <CardHeader
            title="Fill in the details"
            hint="These values drop into the template wherever it names them. A value left blank simply renders as nothing."
          />
          <div className={styles.cardBody}>
            {freeVariables.map((name) => (
              <label key={name} className={styles.field}>
                <span className={styles.fieldLabel}>{name}</span>
                <input
                  type="text"
                  className={styles.input}
                  value={values[name] ?? ''}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      [name]: event.target.value,
                    }))
                  }
                />
              </label>
            ))}
          </div>
          <div className={styles.cardFooter}>
            <Button variant="ghost" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button onClick={() => setStep(3)}>Next</Button>
          </div>
        </Card>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Step: Review & send.                                             */}
      {/* ---------------------------------------------------------------- */}
      {stepName === 'Review & send' && template && (
        <Card>
          <CardHeader
            title="Review and send"
            hint={
              first
                ? `Previewed as ${first.name} would receive it; each recipient gets their own name and address.`
                : 'Previewed with example values.'
            }
          />
          <div className={styles.cardBody}>
            <p className={styles.previewSubject}>
              <span className={styles.fieldLabel}>Subject</span> {previewSubject}
            </p>
            <iframe
              className={styles.previewFrame}
              title="Rendered preview of the email"
              sandbox=""
              srcDoc={previewHtml}
            />
            <section className={styles.recipientSection}>
              <h3 className={styles.sectionTitle}>
                Going to {chosen.length} recipient{chosen.length === 1 ? '' : 's'}
              </h3>
              <ul className={styles.summaryList}>
                {chosen.map((entry) => (
                  <li key={entry.key} className={styles.summaryRow}>
                    {entry.name}
                    {entry.email !== entry.name && (
                      <span className={styles.checkDetail}> {entry.email}</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
            {send.error && <ErrorNotice message={send.error} />}
          </div>
          <div className={styles.cardFooter}>
            <Button
              variant="ghost"
              disabled={send.pending}
              onClick={() => setStep(steps.length - 2)}
            >
              Back
            </Button>
            <Button disabled={send.pending} onClick={() => setConfirming(true)}>
              Send
            </Button>
          </div>
        </Card>
      )}

      {confirming && (
        <EmailsDialog
          title="Send this email?"
          titleId="compose-confirm-title"
          onClose={() => {
            if (!send.pending) {
              setConfirming(false);
            }
          }}
        >
          <p className={styles.confirmCopy}>
            This sends &lsquo;{template?.name ?? ''}&rsquo; to {chosen.length}{' '}
            recipient{chosen.length === 1 ? '' : 's'} now. Sending cannot be
            recalled once it has left.
          </p>
          {send.error && <ErrorNotice message={send.error} />}
          <div className={styles.confirmFooter}>
            <Button disabled={send.pending} onClick={() => void confirmSend()}>
              {send.pending ? 'Sending' : 'Send now'}
            </Button>
            <Button
              variant="ghost"
              disabled={send.pending}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </div>
        </EmailsDialog>
      )}
    </div>
  );
}
