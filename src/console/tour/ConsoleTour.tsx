// ============================================================================
// ConsoleTour - the hand-rolled first-load spotlight tour. No tour or tooltip
// library: a fixed full-viewport layer (portalled to body) whose backdrop is
// FOUR stacked shade panels around the current target, leaving the target
// visible through the gap with a brand ring drawn around it. The panels are
// plain divs on design tokens - no SVG mask, no canvas - and the layer itself
// captures every pointer event, so nothing behind it (including the
// highlighted control) is clickable while the tour runs; only the step card
// is interactive.
//
// Targets are found by the `data-tour` attributes ConsoleShell.tsx sets on its
// chrome. The shell is ONE DOM in two presentations, so the same target set
// serves both scripts (tourSteps.ts); crossing the 1024px breakpoint mid-tour
// swaps wording and re-measures, resuming at the step with the matching id.
// Geometry is re-measured on resize, scroll (capture - the rail nav scrolls
// without bubbling to window), orientation change and target resize, all
// rAF-throttled.
//
// A11y: the card is role="dialog" aria-modal, focus moves into it on every
// step, Tab wraps inside it, Escape skips (which records the tour as seen -
// useTourTrigger owns that write). The backdrop announces nothing.
// ============================================================================

import React, {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../../components/Button';
import {
  DESKTOP_MEDIA_QUERY,
  DESKTOP_STEPS,
  MOBILE_STEPS,
  type TourStep,
} from './tourSteps';
import { useTourTrigger } from './useTourTrigger';
import styles from './ConsoleTour.module.css';

/** Breathing room between the target's box and the shade edge / ring. */
const HIGHLIGHT_PAD = 6;
/** Gap between the highlight and the step card, and the viewport margin. */
const CARD_GAP = 12;
/** The card's width; positioning maths and the stylesheet must agree. */
const CARD_WIDTH = 340;
/** Rough card height, used only to CHOOSE a side - the card is content-sized,
 *  so an estimate is enough to keep it from overflowing the viewport. */
const CARD_EST_HEIGHT = 230;

const FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

interface TargetRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function isDesktopNow(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia(DESKTOP_MEDIA_QUERY).matches
  );
}

function targetElement(step: TourStep): HTMLElement | null {
  if (!step.target) {
    return null;
  }
  return document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
}

/** The script minus any step whose target is absent - an admin-only nav item
 *  for a member, a role-gated Validation link - skipped silently, per plan. */
function availableSteps(script: readonly TourStep[]): TourStep[] {
  return script.filter((step) => !step.target || targetElement(step) !== null);
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), Math.max(max, min));

export function ConsoleTour({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  const bodyId = useId();
  const cardRef = useRef<HTMLDivElement>(null);

  // --- which script, live across the breakpoint -------------------------------
  const [isDesktop, setIsDesktop] = useState(isDesktopNow);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      return;
    }
    const mql = window.matchMedia(DESKTOP_MEDIA_QUERY);
    const onChange = (event: MediaQueryListEvent) => setIsDesktop(event.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  const script = isDesktop ? DESKTOP_STEPS : MOBILE_STEPS;

  // --- the step list and position ---------------------------------------------
  const [steps, setSteps] = useState<TourStep[]>(() => availableSteps(script));
  const [index, setIndex] = useState(0);
  const step: TourStep | undefined = steps[index];

  // The current step's id, for resuming after a script swap. A ref, because
  // the swap effect must read it without re-running on every step change.
  const stepIdRef = useRef<string>(step?.id ?? 'welcome');
  useEffect(() => {
    if (step) {
      stepIdRef.current = step.id;
    }
  }, [step]);

  // Crossing 1024px mid-tour: re-filter the OTHER script (same target set,
  // same DOM) and resume at the step with the matching id.
  useEffect(() => {
    const next = availableSteps(script);
    setSteps(next);
    setIndex((current) => {
      const found = next.findIndex((s) => s.id === stepIdRef.current);
      return found >= 0 ? found : clamp(current, 0, next.length - 1);
    });
  }, [script]);

  // --- geometry ---------------------------------------------------------------
  const [rect, setRect] = useState<TargetRect | null>(null);
  useEffect(() => {
    if (!step) {
      return;
    }
    const element = targetElement(step);
    if (!element) {
      // No target (welcome/done) or it vanished mid-tour: centred card, full dim.
      setRect(null);
      return;
    }
    // The rail nav scrolls on short screens and the mobile nav row scrolls
    // sideways; bring the target into view before the first measurement.
    // (Optional call: jsdom has no scrollIntoView.)
    element.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });

    let frame = 0;
    const measure = () => {
      frame = 0;
      const box = element.getBoundingClientRect();
      setRect({ top: box.top, left: box.left, width: box.width, height: box.height });
    };
    // rAF-throttled: a scroll or resize burst collapses to one measurement per
    // frame.
    const schedule = () => {
      if (frame === 0) {
        frame = requestAnimationFrame(measure);
      }
    };
    measure();
    window.addEventListener('resize', schedule);
    window.addEventListener('orientationchange', schedule);
    // capture: true - the rail's own nav scroller does not bubble to window.
    window.addEventListener('scroll', schedule, true);
    const observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    observer?.observe(element);
    return () => {
      if (frame !== 0) {
        cancelAnimationFrame(frame);
      }
      window.removeEventListener('resize', schedule);
      window.removeEventListener('orientationchange', schedule);
      window.removeEventListener('scroll', schedule, true);
      observer?.disconnect();
    };
  }, [step]);

  // --- focus and keys ---------------------------------------------------------
  // Focus moves into the card on every step, so the announcement follows the
  // tour rather than the page behind it.
  useEffect(() => {
    cardRef.current?.focus();
  }, [index, steps]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !cardRef.current) {
        return;
      }
      // Tab wraps within the card; focus that somehow left it is pulled back.
      const focusable = Array.from(
        cardRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => !el.hasAttribute('disabled'));
      if (focusable.length === 0) {
        event.preventDefault();
        cardRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (active && !cardRef.current.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (
        event.shiftKey &&
        (active === first || active === cardRef.current)
      ) {
        event.preventDefault();
        last.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  // --- layout maths -----------------------------------------------------------
  // The highlight box: the target's rect plus padding, clamped to the viewport.
  const box = useMemo(() => {
    if (!rect) {
      return null;
    }
    const top = Math.max(rect.top - HIGHLIGHT_PAD, 0);
    const left = Math.max(rect.left - HIGHLIGHT_PAD, 0);
    return {
      top,
      left,
      right: rect.left + rect.width + HIGHLIGHT_PAD,
      bottom: rect.top + rect.height + HIGHLIGHT_PAD,
    };
  }, [rect]);

  const cardStyle = useMemo<React.CSSProperties>(() => {
    if (!box) {
      return {}; // centred by the stylesheet
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(CARD_WIDTH, vw - CARD_GAP * 2);
    // Beside the highlight when there is room - the desktop rail's natural
    // side - otherwise below it, otherwise above (anchored by `bottom` so the
    // content-sized card grows upwards, away from the target).
    if (box.right + CARD_GAP + width <= vw) {
      return {
        top: clamp(box.top, CARD_GAP, vh - CARD_EST_HEIGHT - CARD_GAP),
        left: box.right + CARD_GAP,
        width,
      };
    }
    const left = clamp(box.left, CARD_GAP, vw - width - CARD_GAP);
    if (box.bottom + CARD_GAP + CARD_EST_HEIGHT <= vh) {
      return { top: box.bottom + CARD_GAP, left, width };
    }
    return {
      bottom: clamp(vh - box.top + CARD_GAP, CARD_GAP, vh - CARD_GAP),
      left,
      width,
    };
  }, [box]);

  if (!step) {
    return null;
  }
  const last = index === steps.length - 1;

  return createPortal(
    <div className={styles.layer}>
      {box ? (
        // Four shade panels around the highlight; the gap between them IS the
        // spotlight, so the target stays fully visible and un-dimmed.
        <>
          <div className={styles.shade} style={{ top: 0, left: 0, right: 0, height: box.top }} />
          <div className={styles.shade} style={{ top: box.top, left: 0, width: box.left, height: box.bottom - box.top }} />
          <div className={styles.shade} style={{ top: box.top, left: box.right, right: 0, height: box.bottom - box.top }} />
          <div className={styles.shade} style={{ top: box.bottom, left: 0, right: 0, bottom: 0 }} />
          <div
            className={styles.ring}
            style={{
              top: box.top,
              left: box.left,
              width: box.right - box.left,
              height: box.bottom - box.top,
            }}
          />
        </>
      ) : (
        <div className={styles.shade} style={{ inset: 0 }} />
      )}
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        className={box ? styles.card : `${styles.card} ${styles.cardCentred}`}
        style={cardStyle}
      >
        <p className={styles.count}>
          Step {index + 1} of {steps.length}
        </p>
        <h2 id={titleId} className={styles.title}>
          {step.title}
        </h2>
        <p id={bodyId} className={styles.body}>
          {step.body}
        </p>
        <div className={styles.buttonRow}>
          {!last && (
            <button type="button" className={styles.skip} onClick={onClose}>
              Skip tour
            </button>
          )}
          {index > 0 && (
            <Button
              variant="ghost"
              onClick={() => setIndex((current) => Math.max(current - 1, 0))}
            >
              Back
            </Button>
          )}
          <Button
            variant="primary"
            onClick={
              last
                ? onClose
                : () => setIndex((current) => Math.min(current + 1, steps.length - 1))
            }
          >
            {last ? 'Done' : 'Next'}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * The shell's mount point: trigger logic (first run per device class, replay
 * event, done-flag writes) lives in useTourTrigger; this renders the overlay
 * only while a run is active. ConsoleShell mounts it in ORG mode only.
 */
export function ConsoleTourMount() {
  const { active, close } = useTourTrigger();
  if (!active) {
    return null;
  }
  return <ConsoleTour onClose={close} />;
}
