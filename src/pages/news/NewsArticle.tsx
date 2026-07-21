// ============================================================================
// News article - one pre-rendered HTML page per published post.
//
// getStaticPaths (routes.tsx) enumerates only PUBLISHED slugs, so this page is
// pre-rendered exactly once per visible article. An unknown slug, or a scheduled
// article whose publishAt has not passed, renders the shared not-found content
// under a noIndex head: the URL neither leaks the queued post nor enters the
// index as an empty page.
//
// The body renders from the ArticleBlock tagged union, so the output stays
// inside the type system: no raw HTML, no injection surface, and an unhandled
// block kind is a compile error at the switch.
// ============================================================================

import { Link, useParams } from 'react-router-dom';
import { Container, Section } from '../../components/Layout';
import { canonicalUrl, Seo } from '../../seo/Seo';
import { BRAND_NAME } from '../../design/brand';
import { findPublishedArticle, type ArticleBlock, type NewsArticle } from '../../content/news';
import { NotFoundContent } from '../NotFound';
import styles from './NewsArticle.module.css';

/** British long-form date, pinned to UTC (publishAt is a UTC timestamp). */
const dateFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/** Article structured data: the machine-readable twin of the visible header. */
function articleStructuredData(article: NewsArticle): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: article.title,
    description: article.summary,
    datePublished: new Date(article.publishAt).toISOString(),
    mainEntityOfPage: canonicalUrl(`/news/${article.slug}`),
    publisher: {
      '@type': 'Organization',
      name: BRAND_NAME,
      url: canonicalUrl('/'),
    },
  };
}

function Block({ block }: { block: ArticleBlock }) {
  switch (block.kind) {
    case 'paragraph':
      return <p className={styles.paragraph}>{block.text}</p>;
    case 'heading':
      return <h2 className={styles.heading}>{block.text}</h2>;
    case 'list':
      return (
        <ul className={styles.list}>
          {block.items.map((item) => (
            <li key={item} className={styles.listItem}>
              {item}
            </li>
          ))}
        </ul>
      );
  }
}

export function NewsArticlePage() {
  const { slug } = useParams<{ slug: string }>();
  const article = slug ? findPublishedArticle(slug) : undefined;

  if (!article) {
    return (
      <>
        <Seo
          title="Page not found"
          description="The article you were looking for could not be found."
          path="/404"
          noIndex
        />
        <NotFoundContent />
      </>
    );
  }

  const published = new Date(article.publishAt);

  return (
    <>
      <Seo
        title={article.title}
        description={article.summary}
        path={`/news/${article.slug}`}
        ogType="article"
        structuredData={articleStructuredData(article)}
      />

      <Section spacing="tight">
        <Container prose>
          <article>
            <header className={styles.header}>
              <p className={styles.meta}>
                <time dateTime={published.toISOString()}>
                  {dateFormat.format(published)}
                </time>
                <span aria-hidden="true" className={styles.dot}>
                  &middot;
                </span>
                {article.readingMinutes} minute read
              </p>
              <h1 className={styles.title}>{article.title}</h1>
            </header>

            {article.body.map((block, index) => (
              // Index keys are safe here: article bodies are immutable content,
              // never reordered at runtime.
              <Block key={index} block={block} />
            ))}
          </article>

          <p className={styles.back}>
            <Link to="/news" className={styles.backLink}>
              Back to news
            </Link>
          </p>
        </Container>
      </Section>
    </>
  );
}
