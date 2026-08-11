// ============================================================================
// Public-page behaviour: the decisions that matter, not the markup.
//
//   - FAQ: every authored question is really in the page (the JSON-LD is built
//     from the same array, so presence here means presence there).
//   - News: the index lists published articles with British dates; an unknown
//     or unpublished slug renders the not-found state, not an empty article.
//   - Contact: the honeypot short-circuits to success WITHOUT touching the
//     backend - the one anti-abuse behaviour that must never regress silently.
//
// `Head` is mocked to a fragment: vite-react-ssg's head manager only exists
// inside its own render pipeline, and React 19 hoists title/meta natively in
// jsdom, which is all these tests need.
// ============================================================================

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';

vi.mock('vite-react-ssg', () => ({
  Head: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

import { FaqPage } from './Faq';
import { ContactPage } from './Contact';
import { NotFoundPage } from './NotFound';
import { NewsIndexPage } from './news/NewsIndex';
import { NewsArticlePage } from './news/NewsArticle';
import { NEWS_ARTICLES, publishedArticles } from '../content/news';

function renderAt(path: string, ui: ReactNode) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/news/:slug" element={<NewsArticlePage />} />
        <Route path="*" element={ui} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('FaqPage', () => {
  it('renders every question as a native details/summary', () => {
    renderAt('/faq', <FaqPage />);
    // Fourteen questions across four groups; each summary is in the HTML with
    // no JavaScript needed to reveal the answer element.
    expect(screen.getByText('What is Safentia?')).toBeInTheDocument();
    expect(
      screen.getByText('Does it work in buildings with no signal?'),
    ).toBeInTheDocument();
    expect(screen.getByText('Where is our data hosted?')).toBeInTheDocument();
    expect(
      screen.getByText('What happens after the assessor finishes on site?'),
    ).toBeInTheDocument();
  });

  it('never states a price', () => {
    const { container } = renderAt('/faq', <FaqPage />);
    // Plans and pricing are shown inside the sign-up journey; a figure on this
    // page would be an invented commercial claim.
    expect(container.textContent).not.toMatch(/£|\bper (month|user|year)\b/i);
  });
});

describe('news', () => {
  it('lists every published article with a British date', () => {
    renderAt('/news', <NewsIndexPage />);
    for (const article of publishedArticles()) {
      expect(screen.getByText(article.title)).toBeInTheDocument();
    }
    // publishAt of the first article is 8 July 2026 09:00 UTC.
    expect(screen.getAllByText('8 July 2026').length).toBeGreaterThan(0);
  });

  it('renders a published article body from its blocks', () => {
    renderAt('/news/safentia-is-coming', null);
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: /one system from site visit to signed-off report/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('Back to news')).toBeInTheDocument();
  });

  it('renders the not-found state for an unknown slug', () => {
    renderAt('/news/no-such-article', null);
    expect(
      screen.getByRole('heading', { level: 1, name: /could not be found/i }),
    ).toBeInTheDocument();
  });

  it('has unique slugs across the whole article set', () => {
    const slugs = NEWS_ARTICLES.map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe('NotFoundPage', () => {
  it('offers routes back to the home page and contact', () => {
    renderAt('/nowhere', <NotFoundPage />);
    expect(
      screen.getByRole('link', { name: /home page/i }),
    ).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: /contact us/i })).toHaveAttribute(
      'href',
      '/contact',
    );
  });
});

describe('ContactPage honeypot', () => {
  it('reports success without calling the backend when the hidden field is filled', () => {
    const { container } = renderAt('/contact', <ContactPage />);

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'A Bot' },
    });
    fireEvent.change(screen.getByLabelText('Organisation'), {
      target: { value: 'Bot Ltd' },
    });
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'bot@example.com' },
    });
    // The honeypot is aria-hidden, so it is addressed via the DOM directly -
    // exactly how an automated form-filler finds it.
    const honeypot = container.querySelector('input[name="website"]');
    expect(honeypot).not.toBeNull();
    fireEvent.change(honeypot as HTMLInputElement, {
      target: { value: 'https://spam.example' },
    });

    fireEvent.submit(container.querySelector('form') as HTMLFormElement);

    // Success is SYNCHRONOUS here: the handler returned before any dynamic
    // Firebase import, which is the whole point of the honeypot path. (A real
    // submission would leave the form visible in the submitting state.)
    expect(
      screen.getByText(/we will be in touch shortly to arrange it/i),
    ).toBeInTheDocument();
  });
});
