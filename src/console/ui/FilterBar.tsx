// ============================================================================
// FilterBar - the console's one filter control.
//
// Every list screen grew its own filter row and they drifted: the jobs board
// put six controls in a Card and derived its own chip summary by hand, the
// activity trail put six in a Toolbar with no summary at all, and a customer's
// buildings list can only be filtered from the compliance tiles above it. One
// job, three answers, two different input borders.
//
// One answer: a filter TOGGLE that states how many filters are active, an
// inline panel of controls it opens, and - always visible, whether the panel is
// open or shut - a row of removable chips naming exactly what is filtering the
// list. The chips and the count are not decoration: a collapsed panel that
// silently hides three active filters is worse than the clunky row it replaced,
// so they are the entire reason this is safe to collapse.
//
// Callers DECLARE their filters and own the state; this renders them, derives
// the chips from them, and clears them. Nothing about a filter is written
// twice, so a new filter cannot appear in the panel and go missing from the
// summary - which is precisely what the jobs board's parallel chip list was one
// edit away from.
//
// The panel is INLINE, never a floating popover. PageGrid pins each column with
// `overflow-y: auto` above 1024px (see Grid.module.css), which would CLIP an
// absolutely positioned panel; and in the console's narrow main column a
// popover has nowhere to go anyway. Expanding in place also behaves identically
// on a phone, with no positioning to get wrong.
// ============================================================================

import React from 'react';
import { Button } from '../../components/Button';
import styles from './FilterBar.module.css';

// ----------------------------------------------------------------------------
// The field vocabulary. Four kinds cover every list in the console; add a fifth
// here (a numeric range, say) and all three callers get it for free.
// ----------------------------------------------------------------------------

export interface FilterOption {
  value: string;
  label: string;
}

interface FieldBase {
  /** Used verbatim as the control's id (so `htmlFor` is stable and greppable)
   *  and as the React key. Namespace it per page, e.g. 'jobs-status'. */
  id: string;
  /** The visible field label, and the first half of its chip: "Status: Released". */
  label: string;
}

/** Free text. Empty string means "not filtering". */
export interface SearchFilter extends FieldBase {
  kind: 'search';
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

/** One-of. Empty string is the "all" option and means "not filtering". */
export interface SelectFilter extends FieldBase {
  kind: 'select';
  value: string;
  onChange: (value: string) => void;
  /** Wording of the empty option, e.g. 'All statuses'. Never just "All": the
   *  word after it is what tells a screen-reader user which list they are in. */
  allLabel: string;
  options: FilterOption[];
}

/** A yyyy-mm-dd pair. The two bounds are INDEPENDENT filters - each gets its own
 *  chip and can be removed on its own - because "everything since March" is a
 *  real thing to ask for and clearing it should not clear the other end. */
export interface DateRangeFilter extends FieldBase {
  kind: 'dateRange';
  from: string;
  to: string;
  onChangeFrom: (value: string) => void;
  onChangeTo: (value: string) => void;
  fromLabel?: string;
  toLabel?: string;
  /** How a bound reads in its chip. Callers own this because the two pages
   *  disagree on purpose: job slots are LOCAL times, the audit trail is UTC.
   *  Defaults to the raw yyyy-mm-dd, which is honest if unlovely. */
  formatValue?: (value: string) => string;
}

/** Any-of. An empty selection means "all": narrowing to nothing would show an
 *  empty list, which nobody ever wants. */
export interface ChipsFilter extends FieldBase {
  kind: 'chips';
  value: readonly string[];
  onChange: (next: string[]) => void;
  options: FilterOption[];
}

export type FilterField =
  | SearchFilter
  | SelectFilter
  | DateRangeFilter
  | ChipsFilter;

/** One thing currently narrowing the list: how it reads, and how to undo it. */
export interface ActiveFilter {
  key: string;
  label: string;
  onRemove: () => void;
}

// ----------------------------------------------------------------------------
// Derivation. Exported because a page needs the same two answers OUTSIDE the
// bar: "is anything filtering?" (for its filtered-empty state) and "clear
// everything" (for that state's recovery button). Deriving both from the same
// field list is what stops the page and the bar disagreeing.
// ----------------------------------------------------------------------------

/** Every active filter, in field order, each with its own removal. The length
 *  of this list IS the number on the toggle's badge - so the count a reader
 *  sees can always be checked against the chips beside it. */
export function activeFilters(fields: readonly FilterField[]): ActiveFilter[] {
  const active: ActiveFilter[] = [];
  for (const field of fields) {
    switch (field.kind) {
      case 'search': {
        const needle = field.value.trim();
        if (needle) {
          active.push({
            key: field.id,
            label: `${field.label}: "${needle}"`,
            onRemove: () => field.onChange(''),
          });
        }
        break;
      }
      case 'select': {
        if (field.value) {
          const option = field.options.find((item) => item.value === field.value);
          active.push({
            key: field.id,
            // An id is not an answer to "what is filtering this list?", but a
            // stale value whose option has gone is better shown than hidden.
            label: `${field.label}: ${option?.label ?? field.value}`,
            onRemove: () => field.onChange(''),
          });
        }
        break;
      }
      case 'dateRange': {
        const format = field.formatValue ?? ((value: string) => value);
        if (field.from) {
          active.push({
            key: `${field.id}-from`,
            label: `${field.fromLabel ?? 'From'} ${format(field.from)}`,
            onRemove: () => field.onChangeFrom(''),
          });
        }
        if (field.to) {
          active.push({
            key: `${field.id}-to`,
            label: `${field.toLabel ?? 'To'} ${format(field.to)}`,
            onRemove: () => field.onChangeTo(''),
          });
        }
        break;
      }
      case 'chips': {
        for (const value of field.value) {
          const option = field.options.find((item) => item.value === value);
          active.push({
            key: `${field.id}-${value}`,
            label: `${field.label}: ${option?.label ?? value}`,
            onRemove: () =>
              field.onChange(field.value.filter((item) => item !== value)),
          });
        }
        break;
      }
    }
  }
  return active;
}

/** Clear every filter. Only fields that are actually set are written, so this
 *  costs nothing on an unfiltered list. */
export function clearAllFilters(fields: readonly FilterField[]): void {
  for (const field of fields) {
    switch (field.kind) {
      case 'search':
      case 'select':
        if (field.value) {
          field.onChange('');
        }
        break;
      case 'dateRange':
        if (field.from) {
          field.onChangeFrom('');
        }
        if (field.to) {
          field.onChangeTo('');
        }
        break;
      case 'chips':
        if (field.value.length > 0) {
          field.onChange([]);
        }
        break;
    }
  }
}

// ----------------------------------------------------------------------------
// The bar.
// ----------------------------------------------------------------------------

export interface FilterBarProps {
  /** Names the PANEL for assistive tech, e.g. 'Filter jobs'. */
  label: string;
  fields: FilterField[];
  /** One quiet line about what the filters can reach and how much they matched
   *  - "12 of 200 loaded jobs match". Announced, so a changed count is heard as
   *  well as seen. */
  note?: React.ReactNode;
  /** The toggle's own wording. 'Filters' is right almost everywhere. */
  toggleLabel?: string;
  /** Opens with the panel already expanded. For a screen whose filters are the
   *  point of visiting it; leave it closed everywhere else. */
  defaultOpen?: boolean;
  /** Drops the bar's own surface for a bar that sits INSIDE a flush Card,
   *  between its CardHeader and its table. */
  inCard?: boolean;
  className?: string;
}

export function FilterBar({
  label,
  fields,
  note,
  toggleLabel = 'Filters',
  defaultOpen = false,
  inCard = false,
  className = '',
}: FilterBarProps) {
  const [open, setOpen] = React.useState(defaultOpen);
  const toggleRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const idBase = React.useId();
  const panelId = `${idBase}-panel`;

  const active = activeFilters(fields);
  const count = active.length;

  /** Focus must never fall to <body>. Anything in here that removes itself -
   *  the last chip, Clear all, the panel closing under the cursor - hands focus
   *  back to the toggle, which is adjacent and states what is left. */
  const focusToggle = () => toggleRef.current?.focus();

  const close = React.useCallback(() => {
    // Read the DOM BEFORE the state change: setOpen is asynchronous, so the
    // panel still holds focus at this point if that is where it was.
    const hadFocus = panelRef.current?.contains(document.activeElement) ?? false;
    setOpen(false);
    if (hadFocus) {
      toggleRef.current?.focus();
    }
  }, []);

  // Escape closes and returns focus. Deliberately a React handler on the
  // wrapper, NOT a document listener: OrgSwitcher is a floating menu that must
  // yield to an Escape anywhere, while this is an inline panel that owns only
  // the keys pressed inside it. stopPropagation so an Escape spent closing the
  // filters is not ALSO spent closing a dialog this bar might one day sit in.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && open) {
      event.stopPropagation();
      close();
    }
  };

  const classes = [styles.bar, inCard ? styles.inCard : '', className]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={classes}
      // The one styling hook for "this list is filtered": the bar takes a brand
      // edge, so the state is visible from across the page and not only from
      // the chips. Absent (not "false") when clean, so CSS can match on it.
      data-filtered={count > 0 ? 'true' : undefined}
      onKeyDown={onKeyDown}
    >
      <div className={styles.row}>
        <button
          type="button"
          ref={toggleRef}
          className={styles.toggle}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => (open ? close() : setOpen(true))}
        >
          <svg
            className={styles.icon}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M2.5 3.5h11l-4.2 5v4.2l-2.6 1.3V8.5z" />
          </svg>
          <span>{toggleLabel}</span>
          {count > 0 && (
            // The badge is aria-hidden and the same number is spelled out
            // below, so the name reads "Filters (3 active)" rather than
            // "Filters 3 3 active".
            <span className={styles.count} aria-hidden="true">
              {count}
            </span>
          )}
          <span className={styles.visuallyHidden}>
            {count === 0
              ? ' (none active)'
              : count === 1
                ? ' (1 active)'
                : ` (${count} active)`}
          </span>
        </button>

        {count > 0 && (
          <div className={styles.summary}>
            <span className={styles.summaryLabel}>Filtered by</span>
            <ul className={styles.chipList} aria-label="Active filters">
              {active.map((filter) => (
                <li key={filter.key}>
                  <button
                    type="button"
                    className={styles.chip}
                    // The visible text truncates at a sane width; the full
                    // wording stays in the name and on hover, so a long search
                    // term is never lost - only shortened.
                    title={filter.label}
                    aria-label={`Remove filter: ${filter.label}`}
                    onClick={() => {
                      filter.onRemove();
                      focusToggle();
                    }}
                  >
                    <span className={styles.chipText}>{filter.label}</span>
                    <span aria-hidden="true" className={styles.chipRemove}>
                      &times;
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <Button
              variant="ghost"
              onClick={() => {
                clearAllFilters(fields);
                focusToggle();
              }}
            >
              Clear all
            </Button>
          </div>
        )}

        {note !== undefined && note !== null && note !== '' && (
          <p className={styles.note} role="status">
            {note}
          </p>
        )}
      </div>

      {/* Kept in the DOM (hidden, not unmounted) so aria-controls always
          resolves to a real element - the same reasoning as DataTable's
          expansion panel - and so a half-typed search term survives a close.
          Named with aria-label rather than aria-labelledby: the toggle's name
          carries a live count, and a group whose name changes as you type is
          noise. aria-controls still ties the two together. */}
      <div
        id={panelId}
        ref={panelRef}
        role="group"
        aria-label={label}
        className={styles.panel}
        hidden={!open}
      >
        <div className={styles.fields}>
          {fields.map((field) => (
            <FilterControl key={field.id} field={field} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// One control per field kind. Each owns its own label association; none of them
// knows anything about the bar around it.
// ----------------------------------------------------------------------------

function FilterControl({ field }: { field: FilterField }) {
  switch (field.kind) {
    case 'search':
      return (
        <div className={`${styles.field} ${styles.fieldWide}`}>
          <label className={styles.label} htmlFor={field.id}>
            {field.label}
          </label>
          <input
            id={field.id}
            type="search"
            className={styles.control}
            placeholder={field.placeholder}
            value={field.value}
            onChange={(event) => field.onChange(event.target.value)}
          />
        </div>
      );

    case 'select':
      return (
        <div className={styles.field}>
          <label className={styles.label} htmlFor={field.id}>
            {field.label}
          </label>
          <select
            id={field.id}
            className={styles.control}
            value={field.value}
            onChange={(event) => field.onChange(event.target.value)}
          >
            <option value="">{field.allLabel}</option>
            {field.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      );

    case 'dateRange':
      return (
        // A fieldset, so the pair announces as one thing ("Visit date, From").
        // Its default min-inline-size is min-content, which refuses to shrink
        // and would push the bar wider than its column - hence the reset.
        <fieldset className={styles.range}>
          <legend className={styles.legend}>{field.label}</legend>
          <div className={styles.rangeInputs}>
            <div className={styles.subField}>
              <label className={styles.label} htmlFor={`${field.id}-from`}>
                {field.fromLabel ?? 'From'}
              </label>
              <input
                id={`${field.id}-from`}
                type="date"
                className={styles.control}
                value={field.from}
                // Each end bounds the other, so an impossible range cannot be
                // entered at all. The old bars let you set To before From and
                // then showed an empty table with no explanation for it.
                max={field.to || undefined}
                onChange={(event) => field.onChangeFrom(event.target.value)}
              />
            </div>
            <div className={styles.subField}>
              <label className={styles.label} htmlFor={`${field.id}-to`}>
                {field.toLabel ?? 'To'}
              </label>
              <input
                id={`${field.id}-to`}
                type="date"
                className={styles.control}
                value={field.to}
                min={field.from || undefined}
                onChange={(event) => field.onChangeTo(event.target.value)}
              />
            </div>
          </div>
        </fieldset>
      );

    case 'chips':
      return (
        // The group carries the name, so the visible heading is hidden from the
        // tree rather than read twice.
        <div
          className={`${styles.field} ${styles.fieldWide}`}
          role="group"
          aria-label={field.label}
        >
          <span className={styles.label} aria-hidden="true">
            {field.label}
          </span>
          <div className={styles.options}>
            {field.options.map((option) => {
              const selected = field.value.includes(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  className={styles.option}
                  aria-pressed={selected}
                  onClick={() =>
                    field.onChange(
                      selected
                        ? field.value.filter((item) => item !== option.value)
                        : [...field.value, option.value],
                    )
                  }
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
      );
  }
}
