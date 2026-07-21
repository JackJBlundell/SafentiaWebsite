// ============================================================================
// Terms of use - for THIS website only.
//
// Deliberately short: these terms govern visiting safentia.co.uk, not
// using the Safentia platform. Platform use is governed by the written
// agreement between Firerite (UK) Limited and the customer organisation, and
// conflating the two here would misstate both. The not-fire-safety-advice
// paragraph mirrors the footer disclaimer word-for-word in substance, because a
// safety product must never imply its marketing copy discharges anyone's legal
// duties.
// ============================================================================

import { Link } from "react-router-dom";
import { Container, Section } from "../../components/Layout";
import { Seo } from "../../seo/Seo";
import styles from "./Legal.module.css";

export function TermsPage() {
  return (
    <>
      <Seo
        title="Terms of use"
        description="The terms that govern use of the Safentia website, operated by Firerite (UK) Limited."
        path="/legal/terms"
      />

      <Section spacing="tight" labelledBy="terms-title">
        <Container prose>
          <h1 id="terms-title" className={styles.title}>
            Terms of use
          </h1>
          <p className={styles.updated}>Last updated: 8 July 2026</p>

          <p className={styles.paragraph}>
            These terms govern your use of this website, safentia.co.uk, which
            is operated by Firerite (UK) Limited. By using the site you accept
            them. They apply to the website only: use of the Safentia platform
            itself is governed by the separate written agreement between
            Firerite (UK) Limited and the subscribing organisation.
          </p>

          <h2 className={styles.heading}>Permitted use</h2>
          <p className={styles.paragraph}>
            You may browse the site, and use the contact form to make a genuine
            enquiry. You must not attempt to gain unauthorised access to any
            part of the site or its backend, probe or test its security, submit
            automated or bulk requests, or use the site in any way that breaks
            the law or interferes with its operation for others.
          </p>

          <h2 className={styles.heading}>Intellectual property</h2>
          <p className={styles.paragraph}>
            The content of this site, including its text, design and the
            Safentia name and wordmark, belongs to Firerite (UK) Limited or its
            licensors. You may view and print pages for your own reference, but
            you may not reproduce the content commercially or pass it off as
            your own.
          </p>

          <h2 className={styles.heading}>Not fire-safety advice</h2>
          <p className={styles.paragraph}>
            The content of this website is information about the Safentia
            product. It is not fire-safety consultancy and it is not advice
            about any particular premises. Responsibility for compliance with
            fire-safety law, including the making of a suitable and sufficient
            fire risk assessment, remains with the Responsible Person at all
            times.
          </p>

          <h2 className={styles.heading}>Liability</h2>
          <p className={styles.paragraph}>
            The site is provided as-is. We take care to keep its content
            accurate, but we do not warrant that it is complete or error-free,
            and we accept no liability for loss arising from reliance on it.
            Nothing in these terms excludes liability that cannot be excluded by
            law.
          </p>

          <h2 className={styles.heading}>Governing law</h2>
          <p className={styles.paragraph}>
            These terms are governed by the law of England and Wales, and the
            courts of England and Wales have exclusive jurisdiction over any
            dispute arising from them.
          </p>

          <h2 className={styles.heading}>Privacy</h2>
          <p className={styles.paragraph}>
            How we handle personal data collected through this site is described
            in the <Link to="/legal/privacy">privacy policy</Link>.
          </p>
        </Container>
      </Section>
    </>
  );
}
