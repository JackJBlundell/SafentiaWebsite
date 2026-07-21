// ============================================================================
// News content (stories 2073 / 2074).
//
// Articles are repository content, not database records, and that is a deliberate
// choice. The pre-render pass must know every article at BUILD time to emit an
// indexable HTML file per post (story 2073 AC2); an article living in the database
// could not be pre-rendered, and a client-rendered post is a post Google reads as
// an empty page.
//
// Scheduling: `publishAt` is an epoch millisecond timestamp, matching the whole
// platform's date convention (SCHEMA_CHANGES section 4). An article whose
// publishAt is in the future is excluded from the index, the sitemap and the
// pre-render, and its URL returns the not-found page. Automatic publication on a
// schedule (story 2074) requires the deploy pipeline from FR-E26 to exist, since
// a queued post only becomes visible on the next build. That dependency is
// recorded in FUTURE_WORK.md rather than faked here.
//
// Copy status: the Agreement (clause 5.2) has the Developer draft news content and
// the Client finalise it. Every article below is a DRAFT for Firerite's approval.
// Nothing in them states a statistic, a case study or a claim about Firerite that
// we cannot source; where a figure would normally sit, the copy refers to the
// legislation itself, which is quotable and checkable.
// ============================================================================

export interface NewsArticle {
  /** URL segment. Stable forever once published: changing it breaks inbound links. */
  slug: string;
  title: string;
  /** One sentence. Used as the meta description and the index card summary. */
  summary: string;
  /** Epoch millis, UTC. */
  publishAt: number;
  /** Minutes, rounded. Shown on the card so a reader can judge the commitment. */
  readingMinutes: number;
  /** Body paragraphs and headings. Deliberately a small tagged union rather than
   *  raw HTML or Markdown: it keeps the rendered output inside our type system and
   *  makes an unescaped-HTML mistake impossible. */
  body: ArticleBlock[];
}

export type ArticleBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; text: string }
  | { kind: 'list'; items: string[] };

/**
 * The article set. Ordered newest first by `publishAt` at read time, not here, so
 * adding an article never depends on remembering to place it correctly.
 */
export const NEWS_ARTICLES: NewsArticle[] = [
  {
    slug: 'safentia-is-coming',
    title: 'Safentia is coming: one system from site visit to signed-off report',
    summary:
      'Safentia carries a fire risk assessment from the first photograph on site to a validated, released PDF report, in one system.',
    publishAt: Date.UTC(2026, 6, 8, 9, 10),
    readingMinutes: 4,
    body: [
      {
        kind: 'paragraph',
        text: 'Most fire risk assessments still travel a long way between the building and the final report. Notes are taken on paper or in a generic form app, photographs sit on a phone, findings are typed up days later, and the report is assembled by hand in a word processor. Every handover between those steps is a chance for something to be lost, mislabelled or quietly contradicted.',
      },
      {
        kind: 'paragraph',
        text: 'Safentia is built to remove those handovers. It is one system that carries an assessment from the moment an assessor arrives on site to the moment a validated report is released to the customer, and every step in between leaves a record.',
      },
      { kind: 'heading', text: 'On site' },
      {
        kind: 'paragraph',
        text: 'Assessors work through a structured template on a phone or tablet: templates structured in line with PAS 79-1:2020 for general premises, and BS 9792 for housing. Photographs are captured and titled as evidence against the question they answer, not left to be matched up from a camera roll later. Non-conformities are recorded where they are found, with a severity, a responsible party, a due date and, where it applies, a Life Protection flag. Findings can be pinned to a location on the floor plan.',
      },
      {
        kind: 'paragraph',
        text: 'All of this works with no signal at all. Capture is fully offline, and everything syncs automatically when a connection returns, which matters in exactly the places fire risk assessments happen: basements, plant rooms, stairwells and buildings with no tenant Wi-Fi.',
      },
      { kind: 'heading', text: 'Validation before release' },
      {
        kind: 'paragraph',
        text: 'A completed assessment does not go straight out of the door. It moves through a defined lifecycle: Assessment in progress, Ready for validation, More information required, where an auditor flags specific questions back to the assessor, then Complete, ready for release, and finally Released. The auditor sees exactly what the assessor recorded, question by question, and the conversation about a flagged item is attached to the item itself.',
      },
      { kind: 'heading', text: 'The report' },
      {
        kind: 'paragraph',
        text: 'When an assessment is released, the branded PDF report is generated on the server from the validated record, so the report and the underlying data can never disagree. It includes a proportionally accurate Green, Amber and Red risk profile and an action plan ordered by severity, so the responsible person reads the most serious items first.',
      },
      {
        kind: 'paragraph',
        text: 'Safentia runs as an iOS and Android app for the field and a web console for the office, with invited customer access so clients can see their own reports. If you would like to see it working on a real assessment, book a demonstration through the contact page.',
      },
    ],
  },
  {
    slug: 'pas-79-1-2020-in-plain-english',
    title:
      'PAS 79-1:2020 in plain English: what the structure actually asks of an assessor',
    summary:
      'PAS 79-1:2020 is a methodology, not a form. A plain-English walk through what its structure asks an assessor to do, and why the order matters.',
    publishAt: Date.UTC(2026, 6, 8, 9, 5),
    readingMinutes: 5,
    body: [
      {
        kind: 'paragraph',
        text: 'PAS 79-1:2020 is often described as a template for fire risk assessments. It is better understood as a methodology: a documented, repeatable way of working through a premises so that two competent assessors, looking at the same building, would examine the same things in the same order and record their reasoning in a way a third party can follow.',
      },
      {
        kind: 'paragraph',
        text: 'The legal duty it supports comes from the Regulatory Reform (Fire Safety) Order 2005, which requires the responsible person to make a suitable and sufficient assessment of the risks. The Order does not prescribe a method. PAS 79-1 is the widely-adopted answer to the question of what a defensible method looks like in practice.',
      },
      { kind: 'heading', text: 'What the structure covers' },
      {
        kind: 'paragraph',
        text: 'The structure moves from context to judgement. In broad terms, it asks the assessor to establish:',
      },
      {
        kind: 'list',
        items: [
          'What the building is: its construction, layout, use and occupancy, and who would be at particular risk in a fire.',
          'How a fire could start: ignition sources, combustible materials and the housekeeping and processes that bring them together.',
          'How a fire would be noticed and how people would escape: detection, alarm, means of escape, emergency lighting and signage.',
          'How the building limits fire once it starts: compartmentation, fire doors and the measures that protect escape routes.',
          'How the premises is managed day to day: testing, maintenance, training, drills and records.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'The order is the point. An assessor who has not established occupancy and persons at risk cannot sensibly judge whether the means of escape are adequate, because adequacy depends on who is escaping. The structure forces the context to be recorded before the judgement that relies on it.',
      },
      { kind: 'heading', text: 'Judgement, evidenced' },
      {
        kind: 'paragraph',
        text: 'None of this removes professional judgement; it disciplines it. The assessor still decides whether a defect is significant and how urgently it needs to be addressed. What the structure adds is the requirement to show the working: what was inspected, what was found, and why the conclusion follows. A finding without evidence is an opinion; a finding with a titled photograph, a severity, a responsible party and a due date is an instruction someone can act on and an auditor can check.',
      },
      {
        kind: 'paragraph',
        text: 'For housing, the same discipline is carried by BS 9792, which addresses the particular risks of residential buildings. Safentia implements both as structured templates, so the methodology is the shape of the assessment itself rather than a document the assessor has to remember to follow.',
      },
    ],
  },
  {
    slug: 'why-offline-first-matters',
    title: 'Why offline-first matters in fire risk assessment',
    summary:
      'Fire risk assessments happen in basements, plant rooms and protected stairwells, exactly where mobile signal fails. Capture has to work offline.',
    publishAt: Date.UTC(2026, 6, 8, 9, 0),
    readingMinutes: 3,
    body: [
      {
        kind: 'paragraph',
        text: 'Think about where the important parts of a fire risk assessment actually happen. The basement, where the switchgear is. The plant room, behind a fire door, surrounded by concrete. The protected stairwell in the core of the building. The riser cupboard. These are, almost by definition, the places where a mobile signal gives up.',
      },
      {
        kind: 'paragraph',
        text: 'A tool that needs a connection to save a finding fails in exactly the rooms where findings live. The failure is rarely obvious, either: the app appears to work, the assessor moves on, and the record turns out to be incomplete hours later, back at the office, when the building is forty miles away.',
      },
      { kind: 'heading', text: 'Offline-first is a design decision, not a feature' },
      {
        kind: 'paragraph',
        text: 'Offline-first means the device is the source of truth while the assessor works. Every answer, photograph, non-conformity and floor-plan flag is committed to storage on the device the moment it is captured. The network is treated as something that comes and goes, not something the job depends on.',
      },
      {
        kind: 'list',
        items: [
          'Capture never blocks: saving a finding costs the same in a basement as it does on the pavement outside.',
          'Sync is automatic: when a connection returns, the record uploads in the background, with nothing for the assessor to remember to do.',
          'Nothing is lost in between: a dead battery or a closed app does not discard work, because the work was already saved.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'There is a quality argument here as well as a convenience one. When capture is reliable, assessors record findings where they stand, while looking at the defect. When it is not, they fall back to photographs and memory, and reconstruct the record later. Every reconstruction is a chance for detail to blur: which floor, which door, which cupboard.',
      },
      {
        kind: 'paragraph',
        text: 'Safentia was built offline-first from the start. Assessors work through the whole assessment with no signal, and the record syncs itself when the building lets go of them. It is one of those properties that is invisible when it works, and it is the difference between a record made on site and a record made from memory.',
      },
    ],
  },
];

/** Articles whose publish time has passed, newest first. */
export function publishedArticles(now: number = Date.now()): NewsArticle[] {
  return NEWS_ARTICLES.filter((article) => article.publishAt <= now).sort(
    (a, b) => b.publishAt - a.publishAt,
  );
}

/** Slugs of published articles. Drives `getStaticPaths` and the sitemap. */
export function publishedArticleSlugs(now: number = Date.now()): string[] {
  return publishedArticles(now).map((article) => article.slug);
}

/** Look up a published article. Returns undefined for an unknown or future slug,
 *  which the article page renders as the not-found state. */
export function findPublishedArticle(
  slug: string,
  now: number = Date.now(),
): NewsArticle | undefined {
  return publishedArticles(now).find((article) => article.slug === slug);
}
