// ============================================================================
// CtaBand - the closing call to action, one per page, on the ink band. The two
// actions mirror the header exactly: the self-serve journey first (create an
// account at /login, subscribe, and the console provisions the organisation),
// with a demonstration kept as the quieter guided path.
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
  body = 'Create your account and choose a plan to start today - or book a demonstration and we will walk through the field app, the validation lifecycle and a released report, end to end.',
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
            <Button to="/signup" variant="primary" size="lg">
              Get started
            </Button>
            <Button to="/contact" variant="secondary" size="lg">
              or book a demonstration
            </Button>
          </div>
        </div>
      </Container>
    </Section>
  );
}
