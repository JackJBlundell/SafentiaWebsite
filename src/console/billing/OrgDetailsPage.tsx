// ============================================================================
// OrgDetailsPage - step ONE of self-serve onboarding (Phase 3 §3.1), and the
// professional first impression: tell us about your organisation BEFORE any
// plan is pitched. Name is required; the address and contact groups are
// optional. Saving goes through the saveOnboardingDetails callable (owner
// node, server-write), which is what makes the journey resumable - and
// editable later from the plan page without disturbing a payment in flight.
//
// The address is COLLECTED as the conventional four UK fields (two lines,
// town, postcode) but STORED as OrgContact's single `address` string - the
// canonical schema shape the provisioned profile and the report cover print -
// composed "line 1, line 2, town, postcode". splitAddress reverses that
// composition when the saved details come back for editing, so the form
// round-trips its own writes.
//
// Rendered inside the shared SubscribeChrome (centred, stepper-led); like
// the plan page it carries the calm "expecting an invitation?" swap for the
// visitor not here to buy.
// ============================================================================

import { useState, type FormEvent, type ReactNode } from 'react';
import type {
  OnboardingOrgDetails,
  SaveOnboardingDetailsRequest,
  SaveOnboardingDetailsResponse,
  UserOnboarding,
} from '../../types';
import { Button } from '../../components/Button';
import { ErrorNotice } from '../ui/Page';
import { useCallable } from '../ui/useCallable';
import { SubscribeChrome } from './SubscribeChrome';
import styles from './OrgDetailsPage.module.css';

/** Org names bound exactly as the server binds them (2..100). */
export const ORG_NAME_MIN = 2;
export const ORG_NAME_MAX = 100;

/** The form's working shape for the address, before composition. */
interface AddressParts {
  line1: string;
  line2: string;
  city: string;
  postcode: string;
}

/** Compose the form's address fields into OrgContact's single string. Empty
 *  parts vanish, so "1 King Street" alone stores exactly that. Exported for
 *  the subscribe tests. */
export function composeAddress(parts: AddressParts): string {
  return [parts.line1, parts.line2, parts.city, parts.postcode]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(', ');
}

/** Reverse composeAddress for editing: last part reads as the postcode,
 *  second-last as the town, first as line 1, anything between as line 2.
 *  Deterministic for strings this form composed; a hand-typed oddity simply
 *  lands across the same boxes and re-saves unchanged. Exported for tests. */
export function splitAddress(address: string | undefined): AddressParts {
  const parts = (address ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return { line1: '', line2: '', city: '', postcode: '' };
  if (parts.length === 1) return { line1: parts[0], line2: '', city: '', postcode: '' };
  if (parts.length === 2) return { line1: parts[0], line2: '', city: parts[1], postcode: '' };
  if (parts.length === 3) return { line1: parts[0], line2: '', city: parts[1], postcode: parts[2] };
  return {
    line1: parts[0],
    line2: parts.slice(1, -2).join(', '),
    city: parts[parts.length - 2],
    postcode: parts[parts.length - 1],
  };
}

export interface OrgDetailsPageProps {
  /** Previously-saved details (an edit, or a resumed journey), or null on a
   *  first visit. */
  initialDetails: OnboardingOrgDetails | null;
  /** Called with the server's updated node after a successful save; the gate
   *  advances to the plan step. */
  onSaved: (onboarding: UserOnboarding) => void;
  /** Present when a saved journey exists: "Back to plans" without re-saving. */
  onBack?: () => void;
  /** The secondary path: swap to the invitation-wait (holding) view. */
  onShowHolding: () => void;
}

function Field({
  id,
  label,
  optional,
  children,
}: {
  id: string;
  label: string;
  optional?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
        {optional && <span className={styles.optional}> (optional)</span>}
      </label>
      {children}
    </div>
  );
}

export function OrgDetailsPage({
  initialDetails,
  onSaved,
  onBack,
  onShowHolding,
}: OrgDetailsPageProps) {
  const save = useCallable<
    SaveOnboardingDetailsRequest,
    SaveOnboardingDetailsResponse
  >('saveOnboardingDetails');

  const [name, setName] = useState(initialDetails?.name ?? '');
  const [addressParts, setAddressParts] = useState<AddressParts>(() =>
    splitAddress(initialDetails?.address),
  );
  const [phone, setPhone] = useState(initialDetails?.phone ?? '');
  const [website, setWebsite] = useState(initialDetails?.website ?? '');
  const [nameError, setNameError] = useState<string | null>(null);

  const setPart = (part: keyof AddressParts) => (value: string) =>
    setAddressParts((current) => ({ ...current, [part]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length < ORG_NAME_MIN || trimmed.length > ORG_NAME_MAX) {
      setNameError(
        `Enter your organisation's name (${ORG_NAME_MIN} to ${ORG_NAME_MAX} characters).`,
      );
      return;
    }
    setNameError(null);
    const address = composeAddress(addressParts);
    const details: OnboardingOrgDetails = {
      name: trimmed,
      ...(address ? { address } : {}),
      ...(phone.trim() ? { phone: phone.trim() } : {}),
      ...(website.trim() ? { website: website.trim() } : {}),
    };
    const result = await save.call({ details });
    if (result) onSaved(result.onboarding);
  };

  const textInput = (
    id: string,
    value: string,
    onChange: (value: string) => void,
    extra: Record<string, unknown> = {},
  ) => (
    <input
      id={id}
      className={styles.input}
      type="text"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={save.pending}
      {...extra}
    />
  );

  return (
    <SubscribeChrome
      step={0}
      heading="Tell us about your organisation"
      lede="Takes about a minute - your progress is saved, and you can change these details at any time."
      width="medium"
    >
      <form className={styles.form} onSubmit={submit} noValidate>
        <div className={styles.card}>
          <fieldset className={styles.group}>
            <legend className={styles.groupTitle}>Organisation</legend>
            <Field id="org-details-name" label="Organisation name">
              <input
                id="org-details-name"
                className={styles.input}
                type="text"
                value={name}
                maxLength={ORG_NAME_MAX}
                autoComplete="organization"
                placeholder="e.g. Acme Fire Safety Ltd"
                aria-invalid={nameError !== null}
                aria-describedby={
                  nameError ? 'org-details-name-error' : 'org-details-name-hint'
                }
                onChange={(event) => {
                  setName(event.target.value);
                  if (nameError) setNameError(null);
                }}
                disabled={save.pending}
              />
              {nameError ? (
                <span id="org-details-name-error">
                  <ErrorNotice message={nameError} />
                </span>
              ) : (
                <span id="org-details-name-hint" className={styles.hint}>
                  Appears on your reports and in emails to your customers.
                </span>
              )}
            </Field>
          </fieldset>

          {/* Address and contact sit SIDE BY SIDE on a laptop so the whole
              task is visible at once - no scrolling to find out what is left
              to do (product owner requirement). Stacks below 44rem. */}
          <div className={styles.columns}>
            <fieldset className={styles.group}>
              <legend className={styles.groupTitle}>
                Address <span className={styles.optional}>(optional)</span>
              </legend>
              <Field id="org-details-address1" label="Address line 1">
                {textInput('org-details-address1', addressParts.line1, setPart('line1'), {
                  autoComplete: 'address-line1',
                  placeholder: 'e.g. 1 King Street',
                })}
              </Field>
              <Field id="org-details-address2" label="Address line 2">
                {textInput('org-details-address2', addressParts.line2, setPart('line2'), {
                  autoComplete: 'address-line2',
                })}
              </Field>
              <div className={styles.fieldRow}>
                <Field id="org-details-city" label="Town or city">
                  {textInput('org-details-city', addressParts.city, setPart('city'), {
                    autoComplete: 'address-level2',
                    placeholder: 'e.g. Manchester',
                  })}
                </Field>
                <Field id="org-details-postcode" label="Postcode">
                  {textInput(
                    'org-details-postcode',
                    addressParts.postcode,
                    setPart('postcode'),
                    { autoComplete: 'postal-code', placeholder: 'e.g. M2 6AW' },
                  )}
                </Field>
              </div>
            </fieldset>

            <fieldset className={styles.group}>
              <legend className={styles.groupTitle}>
                Contact <span className={styles.optional}>(optional)</span>
              </legend>
              <Field id="org-details-phone" label="Phone">
                <input
                  id="org-details-phone"
                  className={styles.input}
                  type="tel"
                  value={phone}
                  autoComplete="tel"
                  placeholder="e.g. 0161 496 0000"
                  onChange={(event) => setPhone(event.target.value)}
                  disabled={save.pending}
                />
              </Field>
              <Field id="org-details-website" label="Website">
                {textInput('org-details-website', website, setWebsite, {
                  inputMode: 'url',
                  autoComplete: 'url',
                  placeholder: 'e.g. acmefire.co.uk',
                })}
              </Field>
            </fieldset>
          </div>
        </div>

        {save.error && <ErrorNotice message={save.error} />}

        <Button type="submit" block disabled={save.pending}>
          {save.pending ? 'Saving…' : 'Continue to plans'}
        </Button>
        {onBack && (
          <button type="button" className={styles.backLink} onClick={onBack}>
            Back to plans without saving
          </button>
        )}
      </form>

      {/* The old default is the new secondary: joining an existing
          organisation happens by invitation, one calm click away. */}
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
