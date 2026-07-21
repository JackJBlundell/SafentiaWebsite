// ============================================================================
// Marketing page invariants.
//
// These are the rules the marketing pages must never drift from:
//   - exactly one h1 per page (document outline and SEO both depend on it);
//   - the two calls to action point at /contact and /login, matching the
//     header (there is no public sign-up);
//   - zero <img> elements: every visual is CSS or inline SVG, so no external
//     request and no layout shift (story 2075);
//   - no skipped heading levels on the home page.
// ============================================================================

import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
// vite-react-ssg's <Head> is react-helmet-async's <Helmet>; outside the SSG
// runtime it needs the provider that the runtime normally supplies.
import { HelmetProvider } from 'react-helmet-async';
import { HomePage } from './Home';
import { HowItWorksPage } from './HowItWorks';
import { AboutPage } from './About';

const PAGES = [
  { name: 'Home', Page: HomePage, path: '/' },
  { name: 'How it works', Page: HowItWorksPage, path: '/how-it-works' },
  { name: 'About', Page: AboutPage, path: '/about' },
] as const;

function renderPage(Page: React.ComponentType, path: string) {
  return render(
    <HelmetProvider>
      <MemoryRouter initialEntries={[path]}>
        <Page />
      </MemoryRouter>
    </HelmetProvider>,
  );
}

describe.each(PAGES)('$name page', ({ Page, path }) => {
  it('renders exactly one h1', () => {
    const { container } = renderPage(Page, path);
    expect(container.querySelectorAll('h1')).toHaveLength(1);
  });

  it('points the primary call to action at /contact', () => {
    const { getAllByRole } = renderPage(Page, path);
    const demoLinks = getAllByRole('link', { name: /book a demonstration/i });
    expect(demoLinks.length).toBeGreaterThan(0);
    for (const link of demoLinks) {
      expect(link).toHaveAttribute('href', '/contact');
    }
  });

  it('points the secondary call to action at /login', () => {
    const { getAllByRole } = renderPage(Page, path);
    const signInLinks = getAllByRole('link', { name: /sign in/i });
    expect(signInLinks.length).toBeGreaterThan(0);
    for (const link of signInLinks) {
      expect(link).toHaveAttribute('href', '/login');
    }
  });

  it('ships no <img> elements at all', () => {
    const { container } = renderPage(Page, path);
    expect(container.querySelectorAll('img')).toHaveLength(0);
  });
});

describe('Home page heading outline', () => {
  it('never skips a heading level', () => {
    const { container } = renderPage(HomePage, '/');
    const headings = Array.from(container.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    expect(headings.length).toBeGreaterThan(1);

    let previousLevel = 0;
    for (const heading of headings) {
      const level = Number(heading.tagName.slice(1));
      // A heading may go any number of levels back up, but only one level down.
      expect(level).toBeLessThanOrEqual(previousLevel + 1);
      previousLevel = level;
    }
  });
});
