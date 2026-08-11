// ============================================================================
// FAQ - the questions a prospective customer actually asks, answered honestly.
//
// The accordion is native <details>/<summary>: it works with JavaScript disabled
// (this page is pre-rendered), it is keyboard-accessible for free, and every
// answer is in the HTML a crawler reads. The same question/answer data feeds the
// FAQPage structured data, so the JSON-LD can never drift from the visible copy.
//
// Copy discipline: every claim here is a shipped product fact. Pricing figures
// are not stated here - plans are shown inside the sign-up journey - and no
// limits or figures are invented (pages.test.tsx enforces the no-price rule).
// ============================================================================

import { Container, Section } from '../components/Layout';
import { Button } from '../components/Button';
import { Seo } from '../seo/Seo';
import styles from './Faq.module.css';

interface FaqEntry {
  question: string;
  answer: string;
}

interface FaqGroup {
  heading: string;
  entries: FaqEntry[];
}

/** One definition drives both the rendered accordion and the JSON-LD. Answers
 *  are plain strings for that reason: structured data wants text, not JSX. */
const FAQ_GROUPS: FaqGroup[] = [
  {
    heading: 'Getting started',
    entries: [
      {
        question: 'What is Safentia?',
        answer:
          'Safentia is a fire risk assessment platform. Assessors capture the assessment on site in a structured template, auditors validate it question by question, and the final branded PDF report is generated on the server from the validated record. It replaces the chain of paper notes, camera rolls and hand-assembled documents with one system.',
      },
      {
        question: 'Which assessment standards does it support?',
        answer:
          'Safentia ships with templates structured in line with PAS 79-1:2020 for general premises and BS 9792 for housing, and your organisation is not limited to them: duplicate a default and customise it, or build an entirely new template of your own. The methodology is the shape of the template itself, so an assessor works through your standard rather than remembering to follow it.',
      },
      {
        question: 'Can we customise the assessments?',
        answer:
          'Yes. Templates define the sections, questions and answer types an assessment uses, and your organisation controls them: start from a provided default and adapt it, or create a new template from scratch. Templates are versioned, and a published version never changes, so an assessment always keeps the exact shape it was carried out against, however the template evolves afterwards. New versions reach your assessors in the app as soon as they are published.',
      },
      {
        question: 'What do we need to run it?',
        answer:
          'An iOS or Android device for assessors in the field, and a web browser for the office. Safentia is an app for capture and a web console for management, validation and reporting; there is nothing to install on your own servers.',
      },
      {
        question: 'How much does it cost?',
        answer:
          'Plans and pricing are shown when you sign up, so you can see exactly what fits the size and shape of your organisation before you commit. If you would rather talk it through first, book a demonstration through the contact page and we will walk you through the product and the commercials together.',
      },
    ],
  },
  {
    heading: 'On site',
    entries: [
      {
        question: 'Does it work in buildings with no signal?',
        answer:
          'Yes. Capture is fully offline: every answer, photograph and finding is saved on the device the moment it is recorded, and everything syncs automatically when a connection returns. Basements, plant rooms and protected stairwells are exactly where assessments happen, so the app never depends on a connection to save work.',
      },
      {
        question: 'How is photographic evidence handled?',
        answer:
          'Photographs are captured against the question they answer and titled at the point of capture, so evidence is attached to the finding it supports rather than matched up from a camera roll afterwards.',
      },
      {
        question: 'How are non-conformities recorded?',
        answer:
          'Each non-conformity is recorded where it is found, with a severity, a responsible party, a due date and, where it applies, a Life Protection flag. Those fields are what turn a finding into an action someone owns.',
      },
      {
        question: 'Can findings be placed on a floor plan?',
        answer:
          'Yes. Findings can be flagged at their location on the floor plan, so the report reader can see where a defect is, not just what it is.',
      },
    ],
  },
  {
    heading: 'Validation and reports',
    entries: [
      {
        question: 'What happens after the assessor finishes on site?',
        answer:
          'The assessment moves through a defined lifecycle: Assessment in progress, Ready for validation, More information required, Complete, ready for release, and Released. An auditor reviews the record question by question and can flag specific questions back to the assessor for more information, with the conversation attached to the flagged item itself.',
      },
      {
        question: 'What does the final report look like?',
        answer:
          'A branded PDF, generated on the server from the validated record, so the report and the underlying data can never disagree. It includes a proportionally accurate Green, Amber and Red risk profile and an action plan ordered by severity, so the most serious items are read first.',
      },
      {
        question: 'Can our customers see their reports?',
        answer:
          'Yes. Customers can be invited into Safentia with their own access, scoped to their own premises and reports, so a released report reaches the responsible person without leaving the system.',
      },
    ],
  },
  {
    heading: 'Data and security',
    entries: [
      {
        question: 'Where is our data hosted?',
        answer:
          'Assessment data is stored on Google Firebase in the europe-west1 region (Belgium). Supporting services such as authentication are provided by Google Cloud under the same agreement.',
      },
      {
        question: 'How is our data separated from other organisations?',
        answer:
          'Safentia is multi-tenant with strict isolation: every record belongs to exactly one organisation, and access rules are enforced on the server so one organisation can never read the data of another.',
      },
      {
        question: 'What user roles are available?',
        answer:
          'Admin, assessor, auditor, finance and viewer. A user can hold more than one role, and permissions are the union of the roles they hold, so a small team does not need five separate accounts.',
      },
    ],
  },
];

/** FAQPage structured data, derived from the same entries the page renders. */
function faqStructuredData(): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: FAQ_GROUPS.flatMap((group) =>
      group.entries.map((entry) => ({
        '@type': 'Question',
        name: entry.question,
        acceptedAnswer: { '@type': 'Answer', text: entry.answer },
      })),
    ),
  };
}

export function FaqPage() {
  return (
    <>
      <Seo
        title="FAQ"
        description="Frequently asked questions about Safentia: standards supported, offline capture, validation, reports, data hosting and roles."
        path="/faq"
        structuredData={faqStructuredData()}
      />

      <Section spacing="tight" labelledBy="faq-title">
        <Container prose>
          <h1 id="faq-title" className={styles.title}>
            Frequently asked questions
          </h1>
          <p className={styles.lede}>
            Straight answers about what Safentia does and how it handles your
            data. If your question is not here, ask us directly.
          </p>
        </Container>
      </Section>

      <Section spacing="tight">
        <Container prose>
          {FAQ_GROUPS.map((group) => (
            <div key={group.heading} className={styles.group}>
              <h2 className={styles.groupHeading}>{group.heading}</h2>
              {group.entries.map((entry) => (
                <details key={entry.question} className={styles.item}>
                  <summary className={styles.question}>{entry.question}</summary>
                  <p className={styles.answer}>{entry.answer}</p>
                </details>
              ))}
            </div>
          ))}
        </Container>
      </Section>

      <Section spacing="tight">
        <Container prose>
          <div className={styles.cta}>
            <p className={styles.ctaText}>Ready when you are.</p>
            <Button to="/login" variant="primary">
              Get started
            </Button>
            <Button to="/contact" variant="ghost">
              or book a demonstration
            </Button>
          </div>
        </Container>
      </Section>
    </>
  );
}
