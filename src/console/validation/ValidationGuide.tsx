// ============================================================================
// ValidationGuide - the four steps of a review, stated once at the top of the
// page.
//
// Written after an auditor completed two validations, wrote a message on every
// unanswered question, and then reported: "I did not know how to send it back
// to the assessor." The messages were sitting in the flag basket the whole time.
// Nothing on the page had ever told them that flagging is a two-part action -
// write on each question, then send the batch once - so they reasonably assumed
// writing WAS sending.
//
// So the guide's job is not a feature tour. It is one sentence per step, and the
// step that actually caught someone out ("then send them together") is the one
// it spends its words on. It opens itself for an auditor who has not dismissed
// it on this device and collapses to a quiet "How this works" button afterwards,
// which is also how anyone reopens it.
// ============================================================================

import { Button } from '../../components/Button';
import { Card, CardHeader } from '../ui/Card';
import styles from './ValidationGuide.module.css';

interface Step {
  title: string;
  body: string;
}

const STEPS: readonly Step[] = [
  {
    title: 'Read the assessment',
    body: "Every section the assessor was asked, with their answers, photos and any flagged locations. The Progress panel counts what they answered, so gaps are visible before you decide anything.",
  },
  {
    title: 'Flag anything you need more on',
    body: "'Request more information' on a question opens a box for your message. Each one you write is added to the flag basket - it is not sent yet.",
  },
  {
    title: 'Send the whole batch once',
    body: 'The bar at the foot of the screen shows how many questions you have flagged and sends them together, with one deadline. The assessor is notified once, answers them, and resubmits.',
  },
  {
    title: 'Accept, then release',
    body: 'Accepting says nothing is outstanding, so it waits until every request has an answer. Releasing creates the building action plan and generates the report for the customer.',
  },
];

export interface ValidationGuideProps {
  open: boolean;
  onOpen: () => void;
  onDismiss: () => void;
}

export function ValidationGuide({ open, onOpen, onDismiss }: ValidationGuideProps) {
  if (!open) {
    return (
      <div className={styles.collapsed}>
        <Button variant="ghost" type="button" onClick={onOpen}>
          How validation works
        </Button>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader
        title="How validation works"
        hint="Four steps, and the one people miss is the third."
        action={
          <Button variant="ghost" type="button" onClick={onDismiss}>
            Got it
          </Button>
        }
      />
      <ol className={styles.steps}>
        {STEPS.map((step, index) => (
          <li key={step.title} className={styles.step}>
            <span className={styles.number} aria-hidden="true">
              {index + 1}
            </span>
            <div>
              <p className={styles.stepTitle}>{step.title}</p>
              <p className={styles.stepBody}>{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}
