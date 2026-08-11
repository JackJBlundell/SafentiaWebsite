// ============================================================================
// Marketing page invariants.
//
// These are the rules the marketing pages must never drift from:
//   - exactly one h1 per page (document outline and SEO both depend on it);
//   - the primary call to action is the self-serve journey at /login ("Get
//     started"), with the demonstration demoted to the secondary path at
//     /contact, matching the header;
//   - a page ships only the <img> elements it is ALLOWED (see PAGES), every one
//     of them a real product screen in a place where a visitor is deciding
//     whether this is real software, and every other visual drawn in CSS or
//     inline SVG. The rule story 2075 was really protecting is what each allowed
//     image is then checked against: self-hosted, so no third party sees a
//     visitor's IP, and intrinsically sized, so nothing shifts as it loads;
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
  // How it works ships three: the released assessments in the hero, the field
  // app on the "assess on site" step and the console on the release step. The
  // remaining steps stay as CSS mini-cards - a list of three template names is
  // drawn more cheaply than it is photographed.
  { name: 'How it works', Page: HowItWorksPage, path: '/how-it-works', images: 3 },
  // About ships one: the console in the hero. The page's claim is that this was
  // built inside a real fire-safety company, and the capture is that company's
  // own dashboard, named in its header - a stronger form of the same argument
  // than another paragraph would be.
  { name: 'About', Page: AboutPage, path: '/about', images: 1 },
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

  it('points the primary call to action at /login', () => {
    const { getAllByRole } = renderPage(Page, path);
    const startLinks = getAllByRole('link', { name: /get started/i });
    expect(startLinks.length).toBeGreaterThan(0);
    for (const link of startLinks) {
      expect(link).toHaveAttribute('href', '/login');
    }
  });

  it('keeps the demonstration as the secondary call to action at /contact', () => {
    const { getAllByRole } = renderPage(Page, path);
    const demoLinks = getAllByRole('link', { name: /book a demonstration/i });
    expect(demoLinks.length).toBeGreaterThan(0);
    for (const link of demoLinks) {
      expect(link).toHaveAttribute('href', '/contact');
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
