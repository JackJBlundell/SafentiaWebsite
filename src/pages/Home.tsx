// ============================================================================
// Home - the front door of safentia.co.uk.
//
// Every claim on this page is a product fact: what the field app captures, the
// exact validation stage names, what the released report contains. There are
// no testimonials, statistics or customer logos because none exist; the page
// earns credibility by being specific about workflow and legislation instead.
// ============================================================================

import { Container, Section } from "../components/Layout";
import { Button } from "../components/Button";
import {
  Seo,
  organisationStructuredData,
  productStructuredData,
} from "../seo/Seo";
import { BrowserFrame } from "../components/marketing/BrowserFrame";
import { AppScreenshot } from "../components/marketing/AppScreenshot";
import { ProductShot } from "../components/marketing/ProductShot";
import { FeatureCard } from "../components/marketing/FeatureCard";
import { LifecycleStages } from "../components/marketing/LifecycleStages";
import { CtaBand } from "../components/marketing/CtaBand";
import styles from "./Home.module.css";

const DESCRIPTION =
  "Software for fire risk assessment: BS 9792, PAS 79-1:2020 and your own custom templates. " +
  "Offline capture on site, auditor validation and a branded PDF report on release.";

// --- Small inline icons: 20px, currentColor strokes, no library. ------------

const iconProps = {
  viewBox: "0 0 24 24",
  width: 20,
  height: 20,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const OfflineIcon = (
  <svg {...iconProps}>
    <path d="M7 17.5a4.3 4.3 0 0 1-.4-8.6 5.6 5.6 0 0 1 10.9 1.3 3.7 3.7 0 0 1-.5 7.3" />
    <path d="M12 12.5V19m0 0-2.2-2.2M12 19l2.2-2.2" />
  </svg>
);

const ValidateIcon = (
  <svg {...iconProps}>
    <rect x="5" y="3.5" width="14" height="17" rx="2.5" />
    <path d="M9 3.5h6" />
    <path d="M9 13l2.2 2.2L15.5 10" />
  </svg>
);

const ReportIcon = (
  <svg {...iconProps}>
    <path d="M6 3.5h8.5L19 8v12.5H6z" />
    <path d="M14.5 3.5V8H19" />
    <path d="M9 12.5h6M9 16h6" />
  </svg>
);

// --- The six roles. One line each; no invented responsibilities. ------------

const ROLES = [
  {
    name: "Admin",
    line: "Sets up buildings, templates, people and permissions.",
  },
  {
    name: "Assessor",
    line: "Works through templated questions on site, connected or not.",
  },
  {
    name: "Auditor",
    line: "Reviews finished assessments and flags specific questions.",
  },
  {
    name: "Finance",
    line: "Holds commercial access without touching assessment data.",
  },
  {
    name: "Viewer",
    line: "Read-only access across buildings, scores and reports.",
  },
  {
    name: "Customer",
    line: "Invited to view their own buildings, scores and released reports.",
  },
] as const;

export function HomePage() {
  return (
    <>
      <Seo
        title=""
        description={DESCRIPTION}
        path="/"
        structuredData={[
          organisationStructuredData(),
          productStructuredData(DESCRIPTION),
        ]}
      />

      {/* --- Hero ---------------------------------------------------------- */}
      <Section spacing="loose" labelledBy="home-hero-title">
        <Container>
          <div className={styles.hero}>
            <div className={styles.heroCopy}>
              <h1 id="home-hero-title" className={styles.heroTitle}>
                Fire risk assessment, evidenced.
              </h1>
              <p className={styles.heroLead}>
                Safentia is software for fire risk assessment, with templates
                for BS 9792 and PAS 79-1:2020, or built to your own methodology.
                Assessors capture evidence on site, auditors validate it
                question by question, and the Responsible Person receives a
                report they can act on.
              </p>
              <div className={styles.heroActions}>
                <Button to="/login" variant="primary" size="lg">
                  Get started
                </Button>
                <Button to="/contact" variant="secondary" size="lg">
                  or book a demonstration
                </Button>
              </div>
              <p className={styles.heroNote}>
                Native iOS and Android app for the field, a web console for the
                office.
              </p>
            </div>
            <div className={styles.heroVisual}>
              {/* Decorative backdrop. Purely presentational, so it is a div the
                  screen reader never sees rather than anything with meaning. */}
              <span className={styles.heroGlow} aria-hidden="true" />
              <AppScreenshot className={styles.heroPhone} />
            </div>
          </div>
        </Container>
      </Section>

      {/* --- Field to release, in three ------------------------------------ */}
      <Section tone="alt" labelledBy="home-flow-title">
        <Container>
          <h2 id="home-flow-title" className={styles.sectionTitle}>
            From the field to a released report
          </h2>
          <div className={styles.threeUp}>
            <FeatureCard icon={OfflineIcon} title="Capture offline">
              Templated questions, titled photo evidence and floor-plan flags on
              a native app. Basements, plant rooms, no signal: work is stored on
              the device and syncs automatically. Nothing is lost.
            </FeatureCard>
            <FeatureCard icon={ValidateIcon} title="Validate with named stages">
              Every assessment moves through a fixed lifecycle, from Assessment
              in progress to Released. Auditors flag specific questions and
              assessors respond, so nothing goes out unchecked.
            </FeatureCard>
            <FeatureCard icon={ReportIcon} title="Release a branded report">
              On release, a formal PDF is generated server-side: risk profile,
              transparent question tables, a severity-ordered action plan and
              your organisation's own branding.
            </FeatureCard>
          </div>
        </Container>
      </Section>

      {/* --- A closer look --------------------------------------------------- */}
      <Section labelledBy="home-detail-title">
        <Container>
          <h2 id="home-detail-title" className={styles.sectionTitle}>
            A closer look
          </h2>

          <div className={styles.featureRows}>
            <article className={styles.featureRow}>
              <div className={styles.featureCopy}>
                <h3 className={styles.featureTitle}>
                  Built for basements and blackspots
                </h3>
                <p>
                  The field app supports the PAS 79 structure and BS 9792 for
                  housing. Assessors answer templated questions, attach titled
                  photo evidence and pin location flags on floor plans, all
                  fully offline with automatic sync.
                </p>
                <p>
                  Each non-conformity carries a severity of Low, Medium or High,
                  a responsible party, a due date and a Life Protection flag
                  where life safety is at stake. The detail is captured once, on
                  site, not reconstructed later at a desk.
                </p>
              </div>
              {/* Two real screens, overlapped: the templated form the assessor
                  answers, and the floor plan they pin a flag on. The pair says
                  "these are two halves of one job" in a way either alone does
                  not. The form sits behind and larger with about half of it
                  showing; the flag screen sits in front, smaller, and is the one
                  whose content has to stay legible - so it is the one that keeps
                  its detail at the size it is rendered. */}
              <div className={styles.featureVisual} aria-hidden="true">
                <div className={styles.shotPair}>
                  <ProductShot
                    name="app_form_page"
                    width={700}
                    height={1379}
                    sizes="260px"
                    className={styles.shotBehind}
                  />
                  <ProductShot
                    name="app_flag_page"
                    width={700}
                    height={1379}
                    sizes="210px"
                    className={styles.shotFront}
                  />
                </div>
              </div>
            </article>

            <article className={styles.featureRow}>
              <div className={styles.featureCopy}>
                <h3 className={styles.featureTitle}>
                  Validation that leaves a trail
                </h3>
                <p>
                  Every assessment moves through five named stages. An auditor
                  reviews the finished work and, where something needs more,
                  flags the specific questions rather than bouncing the whole
                  job back. The assessor responds to each flag, and the exchange
                  is kept.
                </p>
              </div>
              <div className={styles.featureWide}>
                <LifecycleStages />
              </div>
            </article>

            <article className={styles.featureRow}>
              <div className={styles.featureCopy}>
                <h3 className={styles.featureTitle}>
                  A report the Responsible Person can act on
                </h3>
                <p>
                  On release, the platform generates a formal PDF server-side:
                  an overview, a proportionally accurate Green, Amber and Red
                  risk profile, and every section laid out as a transparent
                  question table. No black box between the assessment and the
                  document.
                </p>
                <p>
                  The action plan is ordered by severity, with titled images and
                  floor-plan locations against each item, under your
                  organisation's own branding and a Conducted by, Checked by and
                  Validated by sign-off.
                </p>
              </div>
              {/* The real console, in the browser frame the mock used to sit in:
                  the frame is what says "this is the web side", and it still
                  earns its place around a genuine screen. */}
              <div className={styles.featureVisual}>
                <BrowserFrame url="safentia.co.uk/app">
                  <ProductShot
                    name="site_stats_page"
                    width={1200}
                    height={838}
                    sizes="(min-width: 900px) 520px, 92vw"
                    className={styles.shotFramed}
                  />
                </BrowserFrame>
              </div>
            </article>
          </div>
        </Container>
      </Section>

      {/* --- Roles ----------------------------------------------------------- */}
      <Section tone="alt" labelledBy="home-roles-title">
        <Container>
          <div className={styles.rolesHead}>
            <h2 id="home-roles-title" className={styles.sectionTitle}>
              Built for the whole organisation
            </h2>
            <p className={styles.rolesLead}>
              Safentia is multi-tenant with full data isolation, and every
              account holds one or more of five staff roles. Customers can be
              invited in with their own scoped access. The web console handles
              setup, validation, reporting and your own assessment templates,
              customised from the provided defaults or built from scratch, while
              buildings carry their own service schedules and an append-only log
              book.
            </p>
          </div>
          <ul className={styles.rolesGrid}>
            {ROLES.map((role) => (
              <li key={role.name} className={styles.roleCard}>
                <h3 className={styles.roleName}>{role.name}</h3>
                <p className={styles.roleLine}>{role.line}</p>
              </li>
            ))}
          </ul>
        </Container>
      </Section>

      <CtaBand />
    </>
  );
}
