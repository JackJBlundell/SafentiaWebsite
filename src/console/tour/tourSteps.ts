// ============================================================================
// tourSteps - the guided tour's two step scripts.
//
// One DOM, two presentations (ConsoleShell.module.css relays the chrome at
// 1024px), so the tour carries TWO scripts over the SAME target set: the
// desktop script talks about "the rail on the left", the mobile script about
// "the bar along the top". ConsoleTour selects the script live via the same
// media query the stylesheet uses, and crossing the breakpoint mid-tour
// resumes at the step with the matching id in the other script.
//
// A step without a target renders as a centred card over a full dim (the
// welcome and the close). A step whose target is absent from the document -
// an admin-only nav item for a member, say - is skipped silently.
// ============================================================================

/** Must mirror the rail breakpoint in ConsoleShell.module.css exactly. */
export const DESKTOP_MEDIA_QUERY = '(min-width: 1024px)';

export interface TourStep {
  /** Stable id shared by the two scripts, so a mid-tour breakpoint crossing
   *  resumes at the equivalent step rather than restarting. */
  id: string;
  /** The `data-tour` attribute value to spotlight (ConsoleShell.tsx sets
   *  these). Absent = a centred card over a full dim. */
  target?: string;
  title: string;
  body: string;
}

/** ≥1024px: the chrome is a left rail. */
export const DESKTOP_STEPS: readonly TourStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to your console',
    body: 'A one-minute tour of the main areas. You can leave at any point.',
  },
  {
    id: 'home',
    target: 'nav-home',
    title: 'Home',
    body: 'The rail on the left is how you move around. Home brings you back to your overview.',
  },
  {
    id: 'customers',
    target: 'nav-customers',
    title: 'Customers',
    body: 'Every customer lives here, with their sites and buildings beneath them.',
  },
  {
    id: 'jobs',
    target: 'nav-jobs',
    title: 'Jobs',
    body: 'Assessments are scheduled here and tracked through to completion.',
  },
  {
    id: 'validation',
    target: 'nav-validation',
    title: 'Validation',
    body: 'Completed assessments wait here for review before their reports are released.',
  },
  {
    id: 'templates',
    target: 'nav-templates',
    title: 'Templates',
    body: 'Templates define the assessment forms your organisation carries out.',
  },
  {
    id: 'search',
    target: 'search',
    title: 'Search',
    body: 'Find a customer, job or building from anywhere in the console.',
  },
  {
    id: 'actions',
    target: 'actions',
    title: 'Your session',
    body: 'At the foot of the rail you can switch organisation, change the theme and manage your account.',
  },
  {
    id: 'done',
    title: 'That is the tour',
    body: 'The Getting started checklist on Home will guide your first steps. You can replay this tour from there at any time.',
  },
] as const;

/** Below 1024px: the chrome is a top bar with a scrolling nav row. The target
 *  set matches the desktop script one for one; only the orientation wording
 *  differs, so the two scripts stay in lockstep across the breakpoint. */
export const MOBILE_STEPS: readonly TourStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to your console',
    body: 'A one-minute tour of the main areas. You can leave at any point.',
  },
  {
    id: 'home',
    target: 'nav-home',
    title: 'Home',
    body: 'The bar along the top is how you move around - swipe it to see every area. Home brings you back to your overview.',
  },
  {
    id: 'customers',
    target: 'nav-customers',
    title: 'Customers',
    body: 'Every customer lives here, with their sites and buildings beneath them.',
  },
  {
    id: 'jobs',
    target: 'nav-jobs',
    title: 'Jobs',
    body: 'Assessments are scheduled here and tracked through to completion.',
  },
  {
    id: 'validation',
    target: 'nav-validation',
    title: 'Validation',
    body: 'Completed assessments wait here for review before their reports are released.',
  },
  {
    id: 'templates',
    target: 'nav-templates',
    title: 'Templates',
    body: 'Templates define the assessment forms your organisation carries out.',
  },
  {
    id: 'search',
    target: 'search',
    title: 'Search',
    body: 'Find a customer, job or building from anywhere in the console.',
  },
  {
    id: 'actions',
    target: 'actions',
    title: 'Your session',
    body: 'Up here you can switch organisation, change the theme and manage your account.',
  },
  {
    id: 'done',
    title: 'That is the tour',
    body: 'The Getting started checklist on Home will guide your first steps. You can replay this tour from there at any time.',
  },
] as const;
