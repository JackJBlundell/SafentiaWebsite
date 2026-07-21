// ============================================================================
// Privacy policy - a real policy, accurate to what the site actually does.
//
// Every statement below was checked against the stack before it was written:
// the site sets no analytics or advertising cookies, loads no third-party
// fonts (Inter is self-hosted via @fontsource), stores only a theme preference
// in localStorage plus Firebase Authentication state for signed-in users, and
// the contact form is the only place a visitor hands us personal data. If the
// stack changes, this page must change with it - a privacy policy that
// overstates or understates the processing is worse than none.
// ============================================================================

import { Container, Section } from "../../components/Layout";
import { Seo } from "../../seo/Seo";
import styles from "./Legal.module.css";

const CONTACT_EMAIL = "contact@safentia.co.uk";

export function PrivacyPage() {
  return (
    <>
      <Seo
        title="Privacy policy"
        description="How Firerite (UK) Limited handles personal data on the Safentia website: what we collect, why, where it is stored and your rights."
        path="/legal/privacy"
      />

      <Section spacing="tight" labelledBy="privacy-title">
        <Container prose>
          <h1 id="privacy-title" className={styles.title}>
            Privacy policy
          </h1>
          <p className={styles.updated}>Last updated: 8 July 2026</p>

          <h2 className={styles.heading}>Who we are</h2>
          <p className={styles.paragraph}>
            Safentia is a product of Firerite (UK) Limited, which is the data
            controller for personal data collected through this website.
          </p>
          <address className={styles.address}>
            Firerite (UK) Limited
            <br />
            Unit 14 Roundabout Court, Bedwas, Caerphilly CF83 8FS
            <br />
            <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
          </address>
          <p className={styles.paragraph}>
            If you have any question about this policy or about your data,
            contact us at the address above and we will respond directly.
          </p>

          <h2 className={styles.heading}>What we collect, and why</h2>
          <p className={styles.paragraph}>
            The only personal data this website collects is what you choose to
            send us through the contact form: your name, organisation, email
            address and, if you provide them, a phone number and a message. We
            use it for one purpose: to answer your enquiry and arrange a
            demonstration. Our lawful basis is legitimate interest - you have
            asked us to get in touch, and responding is what you would expect us
            to do.
          </p>
          <p className={styles.paragraph}>
            Contact-form submissions are stored on Google Firebase in the
            europe-west1 region (Belgium) and retained for up to 24 months, so
            we can follow up on an enquiry that develops slowly. After that they
            are deleted.
          </p>

          <h2 className={styles.heading}>What we do not collect</h2>
          <ul className={styles.list}>
            <li>No analytics. We do not track visits, clicks or behaviour.</li>
            <li>No advertising cookies, and no advertising of any kind.</li>
            <li>
              No third-party fonts or trackers on any page you browse: every
              asset on this site is served by us. The only third-party service
              is the reCAPTCHA check described below, used when you submit the
              contact form.
            </li>
          </ul>
          <p className={styles.paragraph}>
            The site stores exactly two things in your browser: your light or
            dark theme preference (in localStorage), and, if you sign in to the
            Safentia console, the Firebase Authentication state that keeps you
            signed in. Neither is used to track you.
          </p>

          <h2 className={styles.heading}>Protecting our backend</h2>
          <p className={styles.paragraph}>
            Calls from this website to our backend are protected by Firebase App
            Check, which uses a reCAPTCHA-based attestation service provided by
            Google to confirm requests come from the genuine site rather than an
            automated abuser. This processing is limited to that verification.
            If you use the address search in the signed-in console, the text you
            type into it is sent to Mapbox to suggest matching addresses; no
            other personal data accompanies it.
          </p>

          <h2 className={styles.heading}>Data in the Safentia platform</h2>
          <p className={styles.paragraph}>
            Organisations that use the Safentia platform store assessment data,
            including personal data of their own users, within it. For that
            data, the customer organisation is the controller and Firerite (UK)
            Limited processes it only on the controller&rsquo;s instructions,
            under the agreement between us. This policy covers the website; the
            platform is governed by that agreement.
          </p>

          <h2 className={styles.heading}>Sub-processors</h2>
          <p className={styles.paragraph}>
            We use Google Firebase (Google Cloud) to host the website, the
            platform and its data, in the europe-west1 region. When subscription
            billing is introduced, Stripe will process payments; Stripe receives
            payment details directly and we never hold card numbers.
          </p>

          <h2 className={styles.heading}>Your rights</h2>
          <p className={styles.paragraph}>
            Under UK GDPR you have the right to access the personal data we hold
            about you, to have it corrected or erased, to restrict or object to
            our processing of it, and to data portability. To exercise any of
            these rights, email{" "}
            <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>. If you are
            not satisfied with our response, you can complain to the Information
            Commissioner&rsquo;s Office (ico.org.uk).
          </p>

          <h2 className={styles.heading}>Changes to this policy</h2>
          <p className={styles.paragraph}>
            If we change what this website collects or how we use it, we will
            update this policy and the date at the top of this page before the
            change takes effect.
          </p>
        </Container>
      </Section>
    </>
  );
}
