// ============================================================================
// Contact - the book-a-demonstration form, the site's secondary conversion
// path (the primary is the self-serve "Get started" journey at /login).
//
// Firebase is imported LAZILY inside the submit handler and nowhere else. The
// marketing bundle must stay Firebase-free (a visitor who never submits never
// downloads the SDK, and the pre-render pass has no window to initialise it in),
// so both '../firebase' and 'firebase/functions' are dynamic imports that only
// resolve on the first genuine submission.
//
// The form is uncontrolled on purpose: the browser owns the field values, so a
// failed submission keeps everything the visitor typed with no state plumbing,
// and native `required`/`type=email` validation runs before our handler does.
// ============================================================================

import { useState } from "react";
import { Container, Section } from "../components/Layout";
import { Button } from "../components/Button";
import { Seo } from "../seo/Seo";
import type { RegisterInterestInput, RegisterInterestResult } from "../types";
import styles from "./Contact.module.css";

const CONTACT_EMAIL = "contact@safentia.co.uk";

type FormStatus = "idle" | "submitting" | "success" | "error";

/** Mirror of the server's shape check (validate.ts requireEmail): exactly one @,
 *  non-empty local and domain parts, a dot in the domain. Deliberately loose -
 *  deliverability is not checkable client-side and over-strict patterns reject
 *  real addresses. */
function looksLikeEmail(value: string): boolean {
  const at = value.indexOf("@");
  return (
    at > 0 &&
    at === value.lastIndexOf("@") &&
    at < value.length - 1 &&
    value.slice(at + 1).includes(".")
  );
}

export function ContactPage() {
  const [status, setStatus] = useState<FormStatus>("idle");
  const [fieldError, setFieldError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === "submitting") {
      return;
    }

    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get("name") ?? "").trim();
    const organisation = String(data.get("organisation") ?? "").trim();
    const email = String(data.get("email") ?? "").trim();
    const phone = String(data.get("phone") ?? "").trim();
    const message = String(data.get("message") ?? "").trim();
    const honeypot = String(data.get("website") ?? "").trim();

    // The honeypot: no human can see or tab to the "website" field, so a value
    // in it means an automated submitter. We report success WITHOUT calling the
    // backend - a visible rejection would just teach the bot which field to
    // leave blank, whereas a silent success wastes its time.
    if (honeypot.length > 0) {
      setStatus("success");
      return;
    }

    // Native validation has already enforced `required`; this catches an email
    // that is present but not shaped like an address, before a round trip.
    if (!looksLikeEmail(email)) {
      setFieldError("Please enter a valid email address.");
      return;
    }
    setFieldError(null);
    setStatus("submitting");

    try {
      // Lazy on purpose - see the file header. This is the only place the site
      // bundle touches Firebase outside the signed-in console.
      const { firebase, startFirebase } = await import("../firebase");
      const { httpsCallable } = await import("firebase/functions");
      startFirebase();
      const registerInterest = httpsCallable<
        RegisterInterestInput,
        RegisterInterestResult
      >(firebase.functions(), "registerInterest");

      const input: RegisterInterestInput = {
        name,
        organisation,
        email,
        ...(phone ? { phone } : {}),
        ...(message ? { message } : {}),
      };
      await registerInterest(input);
      setStatus("success");
    } catch {
      // The typed input stays in the (uncontrolled) form, so the visitor can
      // retry without retyping, or fall back to the direct email address.
      setStatus("error");
    }
  }

  return (
    <>
      <Seo
        title="Contact"
        description="Book a demonstration of Safentia. Tell us about your organisation and we will be in touch to arrange it."
        path="/contact"
      />

      <Section spacing="tight" labelledBy="contact-title">
        <Container prose>
          <h1 id="contact-title" className={styles.title}>
            Book a demonstration
          </h1>
          <p className={styles.lede}>
            Tell us a little about your organisation and we will arrange a
            demonstration of Safentia on a real assessment.
          </p>
        </Container>
      </Section>

      <Section spacing="tight">
        <Container prose>
          {status === "success" ? (
            <div className={styles.success} role="status">
              <h2 className={styles.successTitle}>Thank you</h2>
              <p className={styles.successText}>
                Thank you - we will be in touch shortly to arrange it.
              </p>
              <p className={styles.successText}>
                If your enquiry is urgent, email us directly at{" "}
                <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
              </p>
            </div>
          ) : (
            <form className={styles.form} onSubmit={handleSubmit}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="contact-name">
                  Name
                </label>
                <input
                  className={styles.input}
                  id="contact-name"
                  name="name"
                  type="text"
                  autoComplete="name"
                  required
                  maxLength={120}
                />
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="contact-organisation">
                  Organisation
                </label>
                <input
                  className={styles.input}
                  id="contact-organisation"
                  name="organisation"
                  type="text"
                  autoComplete="organization"
                  required
                  maxLength={200}
                />
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="contact-email">
                  Email
                </label>
                <input
                  className={styles.input}
                  id="contact-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={254}
                />
                {fieldError && (
                  <p className={styles.fieldError} role="alert">
                    {fieldError}
                  </p>
                )}
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="contact-phone">
                  Phone <span className={styles.optional}>(optional)</span>
                </label>
                <input
                  className={styles.input}
                  id="contact-phone"
                  name="phone"
                  type="tel"
                  autoComplete="tel"
                  maxLength={200}
                />
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="contact-message">
                  Message <span className={styles.optional}>(optional)</span>
                </label>
                <textarea
                  className={styles.textarea}
                  id="contact-message"
                  name="message"
                  rows={5}
                  maxLength={5000}
                />
              </div>

              {/* Honeypot. Hidden from every real visitor (visually, from the
                  accessibility tree and from the tab order); only an automated
                  form-filler completes it, and the submit handler then reports
                  success without ever calling the backend. */}
              <div className={styles.honeypot} aria-hidden="true">
                <label htmlFor="contact-website">Website</label>
                <input
                  id="contact-website"
                  name="website"
                  type="text"
                  tabIndex={-1}
                  autoComplete="off"
                />
              </div>

              {status === "error" && (
                <div className={styles.error} role="alert">
                  <p className={styles.errorText}>
                    Sorry - your message could not be sent. Please try again, or
                    email us directly at{" "}
                    <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
                  </p>
                </div>
              )}

              <div className={styles.actions}>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={status === "submitting"}
                >
                  {status === "submitting" ? "Sending..." : "Send enquiry"}
                </Button>
                <p className={styles.aside}>
                  Or email{" "}
                  <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
                </p>
              </div>
            </form>
          )}
        </Container>
      </Section>
    </>
  );
}
