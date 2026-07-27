// ============================================================================
// RiskExplanation - the two ways the console shows WHY a building carries the
// risk status it does, over one shared body so the wording cannot diverge.
//
//   RiskReasonPanel      the reasons themselves (summary, counts, steps, caveat)
//   RiskReasonDisclosure always-visible summary + an expanding "Why this
//                        status" region, for a detail surface with room
//   RiskReasonBadge      the RAG chip AS a disclosure button, for list rows
//
// Reachability, not just hover. A hover-only tooltip is invisible to keyboard
// and touch users, so the badge is a real <button> with aria-expanded: pointer
// users get it on hover, keyboard users on focus or Enter/Space, touch users on
// tap. Escape closes and hands focus back.
//
// The panel is PORTALLED to <body> and positioned fixed. The console's PageGrid
// gives both of its columns `overflow-y: auto` above 1024px, and an absolutely
// positioned panel inside either column is clipped by that scroll box; a portal
// leaves the clipping ancestor entirely. Being fixed, it is re-measured on
// scroll (capture phase, so the columns' own scrolling counts) and on resize,
// and clamped to the viewport so a row near the right edge or a narrow window
// still shows the whole panel.
// ============================================================================

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { riskPresentation } from '../../design/rag';
import { useTheme } from '../../design/ThemeProvider';
import type { RiskLevel } from '../../types';
import type { RiskExplanation } from './riskReasons';
import styles from './RiskExplanation.module.css';

/** Gap between the trigger and the panel, and the margin kept clear of the
 *  viewport edges when the panel is clamped. */
const PANEL_OFFSET = 8;
const VIEWPORT_MARGIN = 12;
const PANEL_WIDTH = 320;

// ----------------------------------------------------------------------------
// The shared body.
// ----------------------------------------------------------------------------

export function RiskReasonPanel({
  explanation,
  /** The disclosure form already prints the summary above its toggle, so it
   *  suppresses this copy rather than saying the same sentence twice. */
  showSummary = true,
}: {
  explanation: RiskExplanation;
  showSummary?: boolean;
}) {
  const { counts, reasons, assessedNote, caveat, summary } = explanation;
  return (
    <div className={styles.panelBody}>
      {showSummary && <p className={styles.summary}>{summary}</p>}
      {counts && (
        <ul className={styles.counts}>
          <li>
            <span className={styles.countLabel}>High</span>
            <span className={styles.countValue}>{counts.high}</span>
          </li>
          <li>
            <span className={styles.countLabel}>Medium</span>
            <span className={styles.countValue}>{counts.medium}</span>
          </li>
          <li>
            <span className={styles.countLabel}>Low</span>
            <span className={styles.countValue}>{counts.low}</span>
          </li>
          <li>
            <span className={styles.countLabel}>Total</span>
            <span className={styles.countValue}>{counts.total}</span>
          </li>
        </ul>
      )}
      <ol className={styles.reasons}>
        {reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ol>
      {assessedNote && <p className={styles.meta}>{assessedNote}</p>}
      {caveat && <p className={styles.caveat}>{caveat}</p>}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Detail-surface form: the summary is always on screen, the working expands in
// place. Expanding in flow (rather than over the page) means nothing to clip
// and nothing to position.
// ----------------------------------------------------------------------------

export function RiskReasonDisclosure({
  explanation,
}: {
  explanation: RiskExplanation;
}) {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  return (
    <div className={styles.disclosure}>
      <p className={styles.summaryInline}>{explanation.summary}</p>
      <button
        type="button"
        className={styles.disclosureButton}
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        <span aria-hidden="true" className={open ? styles.caretOpen : styles.caret}>
          ▸
        </span>
        {open ? 'Hide how this was worked out' : 'Why this status?'}
      </button>
      <div id={regionId} hidden={!open} className={styles.disclosureRegion}>
        <RiskReasonPanel explanation={explanation} showSummary={false} />
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// List form: the chip itself is the disclosure.
// ----------------------------------------------------------------------------

interface PanelPosition {
  top: number;
  left: number;
  /** Narrowed from PANEL_WIDTH on a phone-width viewport. */
  width: number;
}

export function RiskReasonBadge({
  level,
  explanation,
  buildingName,
}: {
  level: RiskLevel;
  explanation: RiskExplanation;
  /** Named in the button's accessible label so a list of chips is not a list of
   *  identical "High risk" buttons. */
  buildingName: string;
}) {
  const { theme } = useTheme();
  const rag = riskPresentation(theme, level);
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // `pinned` survives the pointer leaving; a hover-opened panel does not.
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [position, setPosition] = useState<PanelPosition>({
    top: 0,
    left: 0,
    width: PANEL_WIDTH,
  });

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    setPinned(false);
    if (returnFocus) {
      triggerRef.current?.focus();
    }
  }, []);

  const measure = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(PANEL_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
    const height = panelRef.current?.offsetHeight ?? 0;
    // Prefer below-left-aligned; flip above when there is not room below.
    const belowTop = rect.bottom + PANEL_OFFSET;
    const fitsBelow = belowTop + height <= window.innerHeight - VIEWPORT_MARGIN;
    const top = fitsBelow
      ? belowTop
      : Math.max(VIEWPORT_MARGIN, rect.top - PANEL_OFFSET - height);
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, rect.left),
      window.innerWidth - VIEWPORT_MARGIN - width,
    );
    setPosition({ top, left, width });
  }, []);

  // Measured after the panel has rendered, so its real height decides the flip.
  useLayoutEffect(() => {
    if (open) {
      measure();
    }
  }, [open, measure]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close(true);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !panelRef.current?.contains(target)
      ) {
        close(false);
      }
    };
    // Capture, because the scrolling element is one of PageGrid's columns
    // rather than the window, and a fixed panel must follow its trigger.
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, close, measure]);

  const openOnHover = () => {
    setOpen(true);
  };
  const closeOnLeave = () => {
    if (!pinned) {
      setOpen(false);
    }
  };

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className={styles.badgeButton}
        style={{ color: rag.color, background: rag.surface }}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${rag.label}: why ${buildingName} has this status`}
        onClick={() => {
          // A tap opens (no hover preceded it); a second press closes.
          setPinned(!open || !pinned);
          setOpen(!open || !pinned);
        }}
        onMouseEnter={openOnHover}
        onMouseLeave={closeOnLeave}
        onFocus={openOnHover}
        onBlur={closeOnLeave}
      >
        <span aria-hidden="true">{rag.icon}</span>
        <span aria-hidden="true">{rag.label}</span>
        <span aria-hidden="true" className={styles.badgeHint}>
          ?
        </span>
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            id={panelId}
            role="group"
            aria-label={`Why ${buildingName} is ${rag.label.toLowerCase()}`}
            className={styles.popover}
            style={{
              top: `${position.top}px`,
              left: `${position.left}px`,
              width: `${position.width}px`,
            }}
            onMouseEnter={openOnHover}
            onMouseLeave={closeOnLeave}
          >
            <RiskReasonPanel explanation={explanation} />
          </div>,
          document.body,
        )}
    </>
  );
}
