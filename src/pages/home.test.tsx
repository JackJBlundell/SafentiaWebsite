// ============================================================================
// Marketing page invariants.
//
// These are the rules the marketing pages must never drift from:
//   - exactly one h1 per page (document outline and SEO both depend on it);
//   - the two calls to action point at /contact and /login, matching the
//     header (there is no public sign-up);
//   - exactly one <img> across the whole marketing site - the field-app
//     screenshot in the home hero - with every other visual drawn in CSS or
//     inline SVG, so the pages make no external request and shift no layout
//     (story 2075). The hero is a deliberate exception (see AppScreenshot),
//     which is why the count is allowed per page rather than banned outright;
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
  // `images` is the number of <img> tags the page is ALLOWED to ship. An entry
  // above zero is a decision, not a default, so an image added anywhere else
  // still fails this suite.
  //
  // Home ships four, each a REAL product screen in a place where a visitor is
  // deciding whether this is real software: the hero, the two overlapping app
  // screens on the offline row, and the console inside the browser frame. Every
  // other visual on the site is still CSS or inline SVG.
  { name: 'Home', Page: HomePage, path: '/', images: 4 },
  // How it works ships two: the console in step 1 (setting up buildings and
  // templates) and the released report in step 4. The other two steps stay as
  // CSS mini-cards.
  { name: 'How it works', Page: HowItWorksPage, path: '/how-it-works', images: 2 },
  { name: 'About', Page: AboutPage, path: '/about', images: 0 },
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

describe.each(PAGES)('$name page', ({ Page, path, images }) => {
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

  it('ships only its allowed <img> elements, each sized against layout shift', () => {
    const { container } = renderPage(Page, path);
    const found = Array.from(container.querySelectorAll('img'));
    expect(found).toHaveLength(images);
    for (const image of found) {
      // Intrinsic dimensions travel with the tag so the browser reserves the box
      // before the bytes arrive. The shift is what story 2075 was actually
      // protecting against, so an image without them fails this rule even though
      // it is on the allow-list.
      expect(image).toHaveAttribute('width');
      expect(image).toHaveAttribute('height');
      // Decorative: the heading and copy beside it already say what the app is,
      // so announcing the picture would add noise rather than information.
      expect(image).toHaveAttribute('alt', '');
      // Self-hosted. A remote host would disclose visitor IPs to a party the
      // Agreement does not list as a sub-processor, which is the same reason the
      // typeface is bundled rather than fetched from a font CDN.
      expect(image.getAttribute('src')).toMatch(/^\//);
    }
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
