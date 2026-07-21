// ============================================================================
// ComplianceGlance - the "compliance at a glance" band (story 2035, FR-E19).
//
// The organisation dashboard's risk band, extracted so the same picture rides
// the top of the customer, site and building detail pages, SCOPED to whatever
// buildings and actions the host passes. One presentational unit: a proportional
// RAG distribution bar over the buildings in scope, then the risk tiles
// (High/Medium/Low/Not yet assessed) and the two escalation tiles (overdue,
// Life Protection overdue), each optionally a drill-through link.
//
// Honest by construction: the host passes the already-scoped building rows and
// action rows, and the counts are derived here through the SAME shared
// orgMetrics helpers the dashboard and the finance reports use, so no two
// surfaces can disagree. `undefined` inputs mean "still attaching" and render a
// skeleton; a loaded-but-empty scope is a real, reportable zero, never invented.
//
// Colour is never the sole carrier: every bar segment and every tile carries a
// text label and its count (the fixed RAG safety language), and `pending` reads
// honestly as "Not yet assessed", deliberately not green.
//
// For a SINGLE building the proportional bar is meaningless, so `single` mode
// degrades gracefully: the building's own RAG status stands in prominently, and
// the tiles become that building's open / overdue / Life Protection counts.
// ============================================================================

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTheme } from '../../design/ThemeProvider';
import { riskPresentation } from '../../design/rag';
import type { Action, RiskLevel } from '../../types';
import { StatCard } from './Card';
import { Skeleton, SkeletonStatus } from './Skeleton';
import {
  countBuildingsByRisk,
  countOverdueActions,
  type BuildingRow,
} from '../reports/orgMetrics';
import styles from './ComplianceGlance.module.css';

/** The drill-through cue on a whole-card stat link: a chevron that fades in on
 *  hover/focus without shifting layout (absolutely positioned, opacity only).
 *  Decorative - the tile's label and number are the link's accessible name. */
function StatChevron() {
  return (
    <span aria-hidden="true" className={styles.statChevron}>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="m6 3.5 4.5 4.5L6 12.5" />
      </svg>
    </span>
  );
}

/** Quiet 16px glyphs for the stat tiles (product-owner preference: icon +
 *  number). Stroke currentColor so they wear the label's muted ink; always
 *  aria-hidden - the label alone carries the meaning. */
const TILE_ICON_PROPS = {
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

const TILE_ICONS = {
  alertTriangle: (
    <svg {...TILE_ICON_PROPS}>
      <path d="M8 2.5 14.5 13.5H1.5L8 2.5Z" />
      <path d="M8 6.8v3" />
      <path d="M8 11.9h.01" />
    </svg>
  ),
  alertCircle: (
    <svg {...TILE_ICON_PROPS}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5.2v3.3" />
      <path d="M8 11h.01" />
    </svg>
  ),
  shieldCheck: (
    <svg {...TILE_ICON_PROPS}>
      <path d="M8 1.8 13 3.6v4.2c0 3.1-2.1 5.3-5 6.4-2.9-1.1-5-3.3-5-6.4V3.6L8 1.8Z" />
      <path d="m5.8 7.8 1.6 1.6 2.8-3" />
    </svg>
  ),
  clipboard: (
    <svg {...TILE_ICON_PROPS}>
      <rect x="3.5" y="2.5" width="9" height="12" rx="1.5" />
      <path d="M6 2.5h4" />
      <path d="M6 7h4M6 10h4" />
    </svg>
  ),
  clock: (
    <svg {...TILE_ICON_PROPS}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.8V8l2.2 1.6" />
    </svg>
  ),
  heart: (
    <svg {...TILE_ICON_PROPS}>
      <path d="M8 13.5 3.2 8.9a3 3 0 0 1 0-4.3 3 3 0 0 1 4.3 0l.5.5.5-.5a3 3 0 0 1 4.3 0 3 3 0 0 1 0 4.3L8 13.5Z" />
    </svg>
  ),
} as const;

/** The risk tiles, in severity order. Tone reinforces the label; the label
 *  alone carries the meaning (colour is never the sole carrier). */
const RISK_TILES: Array<{
  level: RiskLevel;
  label: string;
  tone: 'default' | 'warning' | 'danger';
  icon: ReactNode;
}> = [
  { level: 'high', label: 'High risk', tone: 'danger', icon: TILE_ICONS.alertTriangle },
  { level: 'medium', label: 'Medium risk', tone: 'warning', icon: TILE_ICONS.alertCircle },
  { level: 'low', label: 'Low risk', tone: 'default', icon: TILE_ICONS.shieldCheck },
  { level: 'pending', label: 'Not yet assessed', tone: 'default', icon: TILE_ICONS.clipboard },
];

/** The distribution bar's segment order and label text. The CSS classes map to
 *  the fixed RAG tokens (--rag-red/--rag-amber/--rag-green) plus a neutral for
 *  the not-yet-assessed remainder - deliberately NOT green, so an un-assessed
 *  building never reads as a safe one. */
const RAG_SEGMENTS: Array<{ level: RiskLevel; label: string }> = [
  { level: 'high', label: 'high risk' },
  { level: 'medium', label: 'medium risk' },
  { level: 'low', label: 'low risk' },
  { level: 'pending', label: 'not yet assessed' },
];

/** The scope's risk mix as one proportional bar. Counts ride in the legend
 *  beneath (and in the aria-label sentence), so the colours only ever reinforce
 *  what the text already says; 2px surface gaps separate adjacent segments for
 *  colour-vision safety. */
function RagDistributionBar({
  counts,
  heading,
  emptyNote,
}: {
  counts: Record<RiskLevel, number> | undefined;
  heading: string;
  emptyNote: string;
}) {
  if (counts === undefined) {
    return (
      <div className={styles.ragBarBlock}>
        <SkeletonStatus label="Loading the risk distribution" />
        <Skeleton height="12px" />
      </div>
    );
  }
  const total = RAG_SEGMENTS.reduce(
    (sum, segment) => sum + counts[segment.level],
    0,
  );
  if (total === 0) {
    return <p className={styles.emptyNote}>{emptyNote}</p>;
  }
  const sentence = RAG_SEGMENTS.map(
    (segment) => `${counts[segment.level]} ${segment.label}`,
  ).join(', ');
  return (
    <div className={styles.ragBarBlock}>
      <div
        role="img"
        aria-label={`${heading} across ${total} buildings: ${sentence}.`}
        className={styles.ragBar}
      >
        {RAG_SEGMENTS.filter((segment) => counts[segment.level] > 0).map(
          (segment) => (
            <span
              key={segment.level}
              aria-hidden="true"
              className={`${styles.ragSegment} ${styles[`ragSegment-${segment.level}`]}`}
              style={{ flexGrow: counts[segment.level] }}
            />
          ),
        )}
      </div>
      <ul aria-hidden="true" className={styles.ragLegend}>
        {RAG_SEGMENTS.map((segment) => (
          <li key={segment.level} className={styles.ragLegendItem}>
            <span
              className={`${styles.ragSwatch} ${styles[`ragSegment-${segment.level}`]}`}
            />
            <span className={styles.ragLegendText}>
              {counts[segment.level]} {segment.label}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One tile, wrapped in its drill-through link when a destination exists and
 *  left as a plain tile (no dead affordance) when it does not. */
function GlanceTile({ href, children }: { href?: string; children: ReactNode }) {
  if (href) {
    return (
      <Link to={href} className={styles.statLink}>
        {children}
        <StatChevron />
      </Link>
    );
  }
  return <div className={styles.tile}>{children}</div>;
}

export interface ComplianceGlanceProps {
  /** The building rows in scope; `undefined` while the backing read attaches. */
  buildings: readonly BuildingRow[] | undefined;
  /** The action rows in scope; `undefined` while the backing read attaches. */
  actions: readonly Action[] | undefined;
  /** The bar's heading, and the base of its accessible sentence. Defaults to
   *  the org dashboard's wording. */
  heading?: string;
  /** The empty-scope line shown in place of the bar when the scope has loaded
   *  with no buildings. */
  emptyNote?: string;
  /** Drill-through for a risk tile: the filtered view of THIS scope for that
   *  level. Every host supplies one so the whole band is clickable and feels
   *  identical everywhere; a tile with no destination degrades to plain text
   *  rather than a dead link. */
  riskHref?: (level: RiskLevel) => string | undefined;
  /** Drill-through for the overdue and Life Protection tiles (and, in single
   *  mode, for all three action tiles): the scope's overdue / action view. */
  overdueHref?: string;
  /** Single-building mode: the one building's own RAG replaces the bar, and the
   *  tiles become that building's open / overdue / Life Protection counts. */
  single?: boolean;
}

export function ComplianceGlance({
  buildings,
  actions,
  heading = 'Estate risk distribution',
  emptyNote = "No buildings yet. The estate's risk distribution appears here once buildings are added.",
  riskHref,
  overdueHref,
  single = false,
}: ComplianceGlanceProps) {
  const { theme } = useTheme();

  const overdue = actions ? countOverdueActions(actions, Date.now()) : undefined;

  if (single) {
    // One building: a one-segment bar looks broken, so the building's own RAG
    // status stands in prominently and the tiles read its action plan.
    const building =
      buildings && buildings.length > 0 ? buildings[0].building : undefined;
    const rag =
      building !== undefined
        ? riskPresentation(theme, building.riskLevel ?? 'pending')
        : undefined;
    const openCount = actions
      ? actions.filter((action) => action.status === 'open').length
      : undefined;
    return (
      <section aria-label="Compliance at a glance" className={styles.glance}>
        <div className={styles.ragBarCard}>
          <h2 className={styles.ragBarTitle}>{heading}</h2>
          {rag === undefined ? (
            <div className={styles.ragBarBlock}>
              <SkeletonStatus label="Loading the building risk status" />
              <Skeleton height="2rem" width="10rem" />
            </div>
          ) : (
            <span
              className={styles.statusChip}
              style={{ color: rag.color, background: rag.surface }}
            >
              <span aria-hidden="true">{rag.icon}</span>
              {rag.label}
            </span>
          )}
        </div>
        <div className={styles.tilesSingle}>
          <GlanceTile href={overdueHref}>
            <StatCard
              label="Open actions"
              value={openCount}
              hint="recorded on this building"
              tone="default"
              icon={TILE_ICONS.clipboard}
            />
          </GlanceTile>
          <GlanceTile href={overdueHref}>
            <StatCard
              label="Overdue actions"
              value={overdue?.overdue}
              hint="open, past their due date"
              tone={overdue && overdue.overdue > 0 ? 'warning' : 'default'}
              icon={TILE_ICONS.clock}
            />
          </GlanceTile>
          <GlanceTile href={overdueHref}>
            <StatCard
              label="Life Protection overdue"
              value={overdue?.lifeProtectionOverdue}
              hint="overdue actions that protect life"
              tone={
                overdue && overdue.lifeProtectionOverdue > 0
                  ? 'danger'
                  : 'default'
              }
              icon={TILE_ICONS.heart}
            />
          </GlanceTile>
        </div>
      </section>
    );
  }

  const riskCounts = buildings
    ? countBuildingsByRisk(buildings)
    : undefined;

  return (
    <section aria-label="Compliance at a glance" className={styles.glance}>
      <div className={styles.ragBarCard}>
        <h2 className={styles.ragBarTitle}>{heading}</h2>
        <RagDistributionBar
          counts={riskCounts}
          heading={heading}
          emptyNote={emptyNote}
        />
      </div>
      <div className={styles.tiles}>
        {RISK_TILES.map((tile) => (
          <GlanceTile key={tile.level} href={riskHref?.(tile.level)}>
            <StatCard
              label={tile.label}
              value={riskCounts?.[tile.level]}
              hint="buildings"
              tone={tile.tone}
              icon={tile.icon}
            />
          </GlanceTile>
        ))}
        <GlanceTile href={overdueHref}>
          <StatCard
            label="Overdue actions"
            value={overdue?.overdue}
            hint="open, past their due date"
            tone={overdue && overdue.overdue > 0 ? 'warning' : 'default'}
            icon={TILE_ICONS.clock}
          />
        </GlanceTile>
        <GlanceTile href={overdueHref}>
          <StatCard
            label="Life Protection overdue"
            value={overdue?.lifeProtectionOverdue}
            hint="overdue actions that protect life"
            tone={
              overdue && overdue.lifeProtectionOverdue > 0 ? 'danger' : 'default'
            }
            icon={TILE_ICONS.heart}
          />
        </GlanceTile>
      </div>
    </section>
  );
}
