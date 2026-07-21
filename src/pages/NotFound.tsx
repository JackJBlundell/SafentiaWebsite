// ============================================================================
// 404 - calm, useful, indexed by nobody.
//
// The content is exported separately from the routed page because the news
// article route renders this same content for an unknown or unpublished slug:
// one not-found experience, defined once, whatever URL produced it.
// ============================================================================

import { Container, Section } from '../components/Layout';
import { Button } from '../components/Button';
import { Seo } from '../seo/Seo';
import styles from './NotFound.module.css';

/** The visible not-found state, without document head concerns, so the article
 *  page can reuse it under its own Seo. */
export function NotFoundContent() {
  return (
    <Section spacing="base" labelledBy="not-found-title">
      <Container prose>
        <p className={styles.code}>404</p>
        <h1 id="not-found-title" className={styles.title}>
          That page could not be found
        </h1>
        <p className={styles.text}>
          The address may have been mistyped, or the page may have moved. Nothing
          is broken on your side.
        </p>
        <div className={styles.actions}>
          <Button to="/" variant="primary">
            Go to the home page
          </Button>
          <Button to="/contact" variant="secondary">
            Contact us
          </Button>
        </div>
      </Container>
    </Section>
  );
}

export function NotFoundPage() {
  return (
    <>
      <Seo
        title="Page not found"
        description="The page you were looking for could not be found."
        path="/404"
        noIndex
      />
      <NotFoundContent />
    </>
  );
}
