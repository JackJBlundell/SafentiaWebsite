// ============================================================================
// About - the honest version. Safentia was commissioned by Firerite (UK)
// Limited, a fire-safety company (SiteFooter carries the same facts). No invented founders, dates or milestones appear here because the
// page's whole job is credibility.
// ============================================================================

import { Container, Section } from '../components/Layout';
import { Seo } from '../seo/Seo';
import { BrowserFrame } from '../components/marketing/BrowserFrame';
import { ProductShot } from '../components/marketing/ProductShot';
import { CtaBand } from '../components/marketing/CtaBand';
import styles from './About.module.css';

const DESCRIPTION =
  'Safentia was commissioned by Firerite (UK) Limited, a fire-safety company, replacing paper and ' +
  'office-software fire risk assessment workflows with one system.';

const BELIEFS = [
  {
    title: 'Evidence over assertion',
    body:
      'A finding is worth what stands behind it. Titled photos, floor-plan locations, named ' +
      'severities and an auditor\'s check turn a professional judgement into something the ' +
      'Responsible Person can rely on and a third party can verify.',
  },
  {
    title: 'The assessor\'s time on site is sacred',
    body:
      'The visit is the expensive, unrepeatable part of an assessment. The app exists so that ' +
      'everything is captured once, properly, on the spot, and never reconstructed from memory ' +
      'at a desk two days later.',
  },
  {
    title: 'Reports the Responsible Person can act on',
    body:
      'A report is not a deliverable to file; it is a list of decisions waiting to be made. ' +
      'Transparent question tables, a proportionally accurate risk profile and a ' +
      'severity-ordered action plan make the next step obvious.',
  },
] as const;

const STANDARDS = [
  {
    name: 'The Regulatory Reform (Fire Safety) Order 2005',
    line:
      'The law that requires a suitable and sufficient assessment of fire risk, and places that ' +
      'duty on the Responsible Person.',
  },
  {
    name: 'PAS 79-1:2020',
    line:
      'The publicly available specification setting out a methodology for fire risk assessment. ' +
      'Safentia\'s assessment structure follows it.',
  },
  {
    name: 'BS 9792',
    line:
      'The British Standard covering fire risk assessment in housing, supported as a template ' +
      'alongside the PAS 79 structure.',
  },
] as const;

export function AboutPage() {
  return (
    <>
      <Seo title="About" description={DESCRIPTION} path="/about" />

      {/* --- The story --------------------------------------------------------- */}
      <Section spacing="loose" labelledBy="about-title">
        {/* `prose` has come OFF the Container and the reading measure has moved
            down onto the copy column itself. The story therefore wraps at exactly
            the width it always did, but the row it sits in is no longer capped at
            text width, so the console beside it can be shown at a size where its
            content is legible rather than merely present. */}
        <Container>
          <div className={styles.storyRow}>
            <div className={styles.storyCopy}>
          <h1 id="about-title" className={styles.pageTitle}>
            Built inside a fire-safety company, not beside one
          </h1>
          <div className={styles.story}>
            <p>
              Safentia was commissioned by Firerite (UK) Limited, a fire-safety
              company. It did not begin as a product idea; it began as a working problem.
              Assessments were captured on paper, typed up in office software, and stitched into
              reports by hand. Photos lived in one place, floor plans in another, and the state of
              a job lived in somebody's head.
            </p>
            <p>
              Safentia replaces that with one system. Assessors capture evidence on a native app,
              on site and offline. Auditors validate the work question by question. The report is
              generated from the assessment itself, not retyped from it. And every building keeps
              its history: RAG status, action plans, service schedules and an append-only log
              book.
            </p>
            <p>
              One thing it is not: Safentia is software, not fire-safety consultancy. It helps the
              Responsible Person evidence a suitable and sufficient assessment under the
              Regulatory Reform (Fire Safety) Order 2005. The professional judgement, and the
              responsibility, stay where the law puts them.
            </p>
              </div>
            </div>
            {/* The commissioning company's OWN console, named in the capture's
                header, and the estate view the second paragraph describes: risk
                spread across the buildings, and the overdue actions that follow
                from it. On a page whose whole job is credibility, a screenshot
                that names the company being credited is evidence rather than
                assertion - which is the page's own argument, applied to itself. */}
            <BrowserFrame url="safentia.co.uk/app" className={styles.heroFrame}>
              <ProductShot
                name="site_stats_page"
                width={1200}
                height={838}
                sizes="(min-width: 900px) 500px, 92vw"
                className={styles.shotFramed}
              />
            </BrowserFrame>
          </div>
        </Container>
      </Section>

      {/* --- Beliefs ------------------------------------------------------------ */}
      <Section tone="alt" labelledBy="about-beliefs-title">
        <Container>
          <h2 id="about-beliefs-title" className={styles.sectionTitle}>
            What the platform believes
          </h2>
          <div className={styles.beliefs}>
            {BELIEFS.map((belief) => (
              <article key={belief.title} className={styles.belief}>
                <h3 className={styles.beliefTitle}>{belief.title}</h3>
                <p className={styles.beliefBody}>{belief.body}</p>
              </article>
            ))}
          </div>
        </Container>
      </Section>

      {/* --- Standards ----------------------------------------------------------- */}
      <Section labelledBy="about-standards-title">
        <Container>
          <h2 id="about-standards-title" className={styles.sectionTitle}>
            The standards we align to
          </h2>
          <dl className={styles.standards}>
            {STANDARDS.map((standard) => (
              <div key={standard.name} className={styles.standard}>
                <dt className={styles.standardName}>{standard.name}</dt>
                <dd className={styles.standardLine}>{standard.line}</dd>
              </div>
            ))}
          </dl>
        </Container>
      </Section>

      <CtaBand
        title="See what the work looks like in one system."
        body="Book a demonstration and we will walk through a real assessment, from the first question on site to the released report."
      />
    </>
  );
}
