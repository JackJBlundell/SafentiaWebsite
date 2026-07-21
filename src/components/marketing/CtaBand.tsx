// ============================================================================
// CtaBand - the closing call to action, one per page, on the ink band. The two
// actions mirror the header exactly: a demonstration or a sign-in. There is no
// public sign-up (SiteHeader header comment), so no third path is invented.
// ============================================================================

import { Container, Section } from '../Layout';
import { Button } from '../Button';
import styles from './CtaBand.module.css';

export interface CtaBandProps {
  title?: string;
  body?: string;
}

export function CtaBand({
  title = 'See it on your own buildings.',
  body = 'Book a demonstration and we will walk through the field app, the validation lifecycle and a released report, end to end.',
}: CtaBandProps) {
  return (
    <Section tone="ink" spacing="base" labelledBy="cta-band-title">
      <Container>
        <div className={styles.inner}>
          <div className={styles.copy}>
            <h2 id="cta-band-title" className={styles.title}>
              {title}
            </h2>
            <p className={styles.body}>{body}</p>
          </div>
          <div className={styles.actions}>
            <Button to="/contact" variant="primary" size="lg">
              Book a demonstration
            </Button>
            <Button to="/login" variant="secondary" size="lg">
              Sign in
            </Button>
          </div>
        </div>
      </Container>
    </Section>
  );
}
