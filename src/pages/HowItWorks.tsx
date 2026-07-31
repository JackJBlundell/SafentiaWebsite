// ============================================================================
// How it works - the end-to-end walk, from setup to tracked buildings.
//
// The six steps mirror the product's actual workflow and the lifecycle section
// quotes the five stage names verbatim (LifecycleStages). Visuals are small
// CSS/SVG depictions of real screens, not screenshots, so they follow the
// theme and cost no assets.
// ============================================================================

import { Container, Section } from "../components/Layout";
import { Button } from "../components/Button";
import { Seo } from "../seo/Seo";
import { StepList, type Step } from "../components/marketing/StepList";
import { LifecycleStages } from "../components/marketing/LifecycleStages";
import { BrowserFrame } from "../components/marketing/BrowserFrame";
import { ProductShot } from "../components/marketing/ProductShot";
import { CtaBand } from "../components/marketing/CtaBand";
import styles from "./HowItWorks.module.css";

const DESCRIPTION =
  "From buildings and templates to a released, branded PDF report: how Safentia takes a fire " +
  "risk assessment from site to sign-off, offline included.";

// --- Small step visuals, drawn in CSS. -------------------------------------

function TemplatesVisual() {
  return (
    <div className={styles.miniCard}>
      <p className={styles.miniHeading}>Templates</p>
      <ul className={styles.miniList}>
        <li className={styles.miniRow}>
          <span className={styles.miniTick} />
          PAS 79-1:2020 structure
        </li>
        <li className={styles.miniRow}>
          <span className={styles.miniTick} />
          BS 9792 housing
        </li>
        <li className={styles.miniRow}>
          <span className={styles.miniTick} />
          Your own templates
        </li>
      </ul>
    </div>
  );
}

function ScheduleVisual() {
  return (
    <div className={styles.miniCard}>
      <p className={styles.miniHeading}>This week</p>
      <ul className={styles.miniList}>
        <li className={styles.jobRow}>
          <span className={styles.avatar}>RD</span>
          <span className={styles.jobText}>
            <span className={styles.jobBuilding}>Harbour Point, Block B</span>
            <span className={styles.jobMeta}>PAS 79-1:2020, due Tuesday</span>
          </span>
        </li>
        <li className={styles.jobRow}>
          <span className={styles.avatar}>KA</span>
          <span className={styles.jobText}>
            <span className={styles.jobBuilding}>Weaver Street housing</span>
            <span className={styles.jobMeta}>BS 9792, due Friday</span>
          </span>
        </li>
      </ul>
    </div>
  );
}

function ValidateVisual() {
  return (
    <div className={styles.miniCard}>
      <p className={styles.miniStage}>More information required</p>
      <p className={styles.miniQuestion}>
        Are fire doors to the stairwell self-closing?
      </p>
      <p className={styles.auditorNote}>
        <span className={styles.noteRole}>Auditor</span>
        Photo shows the door wedged open. Confirm the closer is fitted and
        working.
      </p>
      <p className={styles.assessorNote}>
        <span className={styles.noteRole}>Assessor</span>
        Closer fitted and tested on revisit. New titled photo attached.
      </p>
    </div>
  );
}

function TrackVisual() {
  return (
    <div className={styles.miniCard}>
      <p className={styles.miniHeading}>Portfolio</p>
      <ul className={styles.miniList}>
        {/* The SAME H/M/L badges the console shows on a building row, so someone
            who has seen the product recognises them here - and someone who sees
            them here first is not learning a second vocabulary later. They also
            fix what the plain coloured dots could not: a letter carries the level
            for a reader who cannot separate red from green. */}
        <li className={styles.buildingRow}>
          <span className={`${styles.ragBadge} ${styles.ragLow}`} aria-hidden="true">
            L
          </span>
          <span className={styles.jobBuilding}>Harbour Point, Block B</span>
          <span className={styles.jobMeta}>Low risk &middot; FRA review May 2027</span>
        </li>
        <li className={styles.buildingRow}>
          <span className={`${styles.ragBadge} ${styles.ragMedium}`} aria-hidden="true">
            M
          </span>
          <span className={styles.jobBuilding}>Weaver Street housing</span>
          <span className={styles.jobMeta}>Medium risk &middot; alarm service due</span>
        </li>
        <li className={styles.buildingRow}>
          <span className={`${styles.ragBadge} ${styles.ragHigh}`} aria-hidden="true">
            H
          </span>
          <span className={styles.jobBuilding}>Corn Exchange</span>
          <span className={styles.jobMeta}>
            High risk &middot; 2 high-severity actions open
          </span>
        </li>
      </ul>
    </div>
  );
}

// --- The six steps. ----------------------------------------------------------

const STEPS: readonly Step[] = [
  {
    title: "Set up buildings and templates",
    body: (
      <>
        <p>
          Add your buildings in the web console and choose the template each
          assessment will follow: the PAS 79-1:2020 structure for general
          premises, BS 9792 for housing, a default your organisation has
          customised, or a template built entirely from scratch.
        </p>
        <p>
          Every building carries its own RAG status, service schedules and an
          append-only log book from the start.
        </p>
      </>
    ),
    visual: <TemplatesVisual />,
  },
  {
    title: "Schedule jobs to assessors",
    body: (
      <p>
        Assign each assessment to a named assessor with a due date. The job
        arrives in their app with the right building, floor plans and template
        already attached, so time on site is spent assessing, not
        administrating.
      </p>
    ),
    visual: <ScheduleVisual />,
  },
  {
    title: "Assess on site, offline included",
    body: (
      <>
        <p>
          The assessor works through the templated questions on the native iOS
          or Android app: titled photo evidence, location flags pinned on floor
          plans, and non-conformities with a severity, a responsible party, a
          due date and a Life Protection flag.
        </p>
        <p>
          Basements, plant rooms, no signal: everything is stored on the device
          and syncs automatically once coverage returns. Nothing is lost.
        </p>
      </>
    ),
    // The real capture, with NO PhoneFrame around it: the mockup already
    // contains the device, and the CSS bezel drew a phone around a phone.
    visual: (
      <ProductShot
        name="app_form_page_2"
        width={700}
        height={1379}
        sizes="(min-width: 900px) 300px, 60vw"
        className={styles.stepPhone}
      />
    ),
  },
  {
    title: "Validate, question by question",
    body: (
      <p>
        An auditor reviews the finished assessment. Where something needs more,
        they flag the specific questions and the job returns to the assessor as
        More information required. The assessor responds to each flag and
        resubmits, and the exchange stays on the record.
      </p>
    ),
    visual: <ValidateVisual />,
  },
  {
    title: "Release the report and action plan",
    body: (
      <>
        <p>
          On release, a formal PDF report is generated server-side: an overview,
          a proportionally accurate Green, Amber and Red risk profile, and every
          section as a transparent question table.
        </p>
        <p>
          The severity-ordered action plan carries titled images and floor-plan
          locations, under your organisation's branding with a Conducted by,
          Checked by and Validated by sign-off.
        </p>
      </>
    ),
    visual: (
      <BrowserFrame url="safentia.co.uk/app">
        <ProductShot
          name="site_stats_page"
          width={1200}
          height={838}
          sizes="(min-width: 900px) 520px, 92vw"
          className={styles.shotFramed}
        />
      </BrowserFrame>
    ),
  },
  {
    title: "Track buildings between assessments",
    body: (
      <p>
        Every building keeps its RAG status, open actions and review dates.
        Service schedules cover fire alarm service, drills, training, PAT,
        extinguishers and FRA review, the log book records every event
        append-only, and customers can be invited to view their own buildings,
        scores and reports.
      </p>
    ),
    visual: <TrackVisual />,
  },
] as const;

export function HowItWorksPage() {
  return (
    <>
      <Seo
        title="How it works"
        description={DESCRIPTION}
        path="/how-it-works"
      />

      {/* --- Intro ----------------------------------------------------------- */}
      <Section spacing="loose" labelledBy="hiw-title">
        <Container>
          <div className={styles.introRow}>
            <div className={styles.intro}>
              <h1 id="hiw-title" className={styles.pageTitle}>
                From site visit to signed-off report
              </h1>
              <p className={styles.lead}>
                One system carries the assessment the whole way: captured on
                site, validated by an auditor, released as a formal PDF, and
                tracked against the building afterwards. Here is the path, step
                by step.
              </p>
            </div>
            {/* The end of the path, shown at the start of it: the released
                assessments the whole page is describing the route to. */}
            <BrowserFrame url="safentia.co.uk/app" className={styles.heroFrame}>
              <ProductShot
                name="site_releases_page"
                width={1200}
                height={685}
                sizes="(min-width: 900px) 520px, 92vw"
                className={styles.shotFramed}
              />
            </BrowserFrame>
          </div>
        </Container>
      </Section>

      {/* --- The six steps ---------------------------------------------------- */}
      <Section tone="alt" labelledBy="hiw-steps-title">
        <Container>
          <h2 id="hiw-steps-title" className="sr-only">
            The six steps
          </h2>
          <StepList steps={STEPS} />
        </Container>
      </Section>

      {/* --- The lifecycle ----------------------------------------------------- */}
      <Section labelledBy="hiw-lifecycle-title">
        <Container>
          <div className={styles.lifecycleHead}>
            <h2 id="hiw-lifecycle-title" className={styles.sectionTitle}>
              The validation lifecycle
            </h2>
            <p className={styles.lead}>
              Every assessment sits in exactly one of five stages, so anyone in
              the organisation can see where a job is and what happens next.
            </p>
          </div>
          <LifecycleStages detailed />
        </Container>
      </Section>

      {/* --- FAQ teaser --------------------------------------------------------- */}
      <Section tone="alt" spacing="tight" labelledBy="hiw-faq-title">
        <Container>
          <div className={styles.faqTeaser}>
            <div>
              <h2 id="hiw-faq-title" className={styles.faqTitle}>
                Questions before a demonstration?
              </h2>
              <p className={styles.lead}>
                Offline behaviour, roles and permissions, data isolation, what
                the report contains: the FAQ covers the details.
              </p>
            </div>
            <Button to="/faq" variant="secondary">
              Read the FAQ
            </Button>
          </div>
        </Container>
      </Section>

      <CtaBand />
    </>
  );
}
