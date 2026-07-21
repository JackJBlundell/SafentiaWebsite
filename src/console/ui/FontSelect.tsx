// ============================================================================
// FontSelect - a previewing font picker: button + listbox (the OrgSwitcher
// disclosure pattern), NOT a native <select>, because each option must render
// IN its own typeface and native options cannot be styled per-option.
//
// Every option label is drawn in the family it offers, with a short specimen
// line beneath in muted small text, so the choice is made by eye rather than
// by name. Values are BARE family names (or '' for the platform default);
// resolveFontStack appends the safe platform stack both here for the preview
// and downstream wherever the saved value is applied, so a visitor without
// the font installed falls back gracefully rather than to the browser serif.
//
// Keyboard: Enter/Space/ArrowDown on the trigger opens; arrows/Home/End move
// the active option; Enter or Space selects; Escape closes and returns focus
// to the trigger; clicking outside dismisses.
// ============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveFontStack } from '../../design/tokens/typography';
import styles from './FontSelect.module.css';

export interface FontOption {
  /** Bare family name, or '' for the platform default. */
  value: string;
  label: string;
}

export interface FontSelectProps {
  /** Base id: the trigger gets it; options derive `${id}-option-{i}`. */
  id: string;
  /** Id of the visible label element naming the control. */
  labelledBy: string;
  /** The selected option value ('' = platform default). */
  value: string;
  options: FontOption[];
  onChange: (value: string) => void;
  /** The short line rendered under each option name, in that option's face. */
  specimen?: string;
  disabled?: boolean;
}

export function FontSelect({
  id,
  labelledBy,
  value,
  options,
  onChange,
  specimen = 'Fire risk assessment, evidenced.',
  disabled = false,
}: FontSelectProps) {
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const [activeIndex, setActiveIndex] = useState(selectedIndex);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) {
      triggerRef.current?.focus();
    }
  }, []);

  const openList = () => {
    setActiveIndex(selectedIndex);
    setOpen(true);
  };

  // Focus moves onto the listbox when it opens; aria-activedescendant then
  // tracks the highlighted option without moving DOM focus per keystroke.
  useEffect(() => {
    if (open) {
      listRef.current?.focus();
    }
  }, [open]);

  // Clicking outside dismisses without stealing focus.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        close(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, close]);

  const select = (index: number) => {
    onChange(options[index].value);
    close(true);
  };

  const onTriggerKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openList();
    }
  };

  const onListKeyDown = (event: React.KeyboardEvent) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActiveIndex((i) => Math.min(options.length - 1, i + 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
        break;
      case 'Home':
        event.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        event.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        select(activeIndex);
        break;
      case 'Escape':
        event.preventDefault();
        close(true);
        break;
      case 'Tab':
        // Let Tab move on naturally; the popup must not linger behind it. DOM
        // focus is returned to the trigger SYNCHRONOUSLY first: the listbox
        // (the currently-focused node) unmounts when the popup closes, and
        // tabbing out of a node that disappears drops focus to <body>. From
        // the trigger, the browser's default Tab action advances to the
        // natural next control.
        triggerRef.current?.focus();
        close(false);
        break;
      default:
        break;
    }
  };

  const selected = options[selectedIndex];

  return (
    <div className={styles.container} ref={containerRef}>
      <button
        type="button"
        id={id}
        ref={triggerRef}
        className={styles.trigger}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${labelledBy} ${id}-value`}
        disabled={disabled}
        onClick={() => (open ? close(true) : openList())}
        onKeyDown={onTriggerKeyDown}
      >
        <span
          id={`${id}-value`}
          className={styles.triggerLabel}
          style={{ fontFamily: resolveFontStack(selected?.value || undefined) }}
        >
          {selected?.label ?? ''}
        </span>
        <svg
          viewBox="0 0 12 12"
          className={styles.chevron}
          aria-hidden="true"
          focusable="false"
        >
          <path d="M2.5 4.5L6 8l3.5-3.5" fill="none" strokeWidth="1.5" />
        </svg>
      </button>
      {open && (
        <ul
          ref={listRef}
          role="listbox"
          className={styles.list}
          tabIndex={-1}
          aria-labelledby={labelledBy}
          aria-activedescendant={`${id}-option-${activeIndex}`}
          onKeyDown={onListKeyDown}
        >
          {options.map((option, index) => {
            // Each option previews itself: name and specimen in the family it
            // offers, through the same safe stack the console will apply.
            const stack = resolveFontStack(option.value || undefined);
            return (
              <li
                key={option.value || 'default'}
                id={`${id}-option-${index}`}
                role="option"
                aria-selected={option.value === value}
                className={[
                  styles.option,
                  index === activeIndex ? styles.optionActive : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={{ fontFamily: stack }}
                onPointerMove={() => setActiveIndex(index)}
                onClick={() => select(index)}
              >
                <span className={styles.optionName}>{option.label}</span>
                <span className={styles.optionSpecimen}>{specimen}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
