// ============================================================================
// News index - every published article, newest first.
//
// The list is computed from the repository content at render time (which, for
// this page, is BUILD time - the page is pre-rendered), so a scheduled article
// whose publishAt has not passed is simply absent from the HTML. Dates are
// formatted in UTC so the pre-rendered output does not depend on the build
// machine's timezone.
// ============================================================================

import { Link } from 'react-router-dom';
import { Container, Section } from '../../components/Layout';
import { Seo } from '../../seo/Seo';
import { publishedArticles } from '../../content/news';
import styles from './NewsIndex.module.css';

/** British long-form date, pinned to UTC (publishAt is a UTC timestamp). */
const dateFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

export function NewsIndexPage() {
  const articles = publishedArticles();

  return (
    <>
      <Seo
        title="News"
        description="News and writing from the Safentia team: product updates and practical pieces on fire risk assessment methodology."
        path="/news"
      />

      <Section spacing="tight" labelledBy="news-title">
        <Container prose>
          <h1 id="news-title" className={styles.title}>
            News
          </h1>
          <p className={styles.lede}>
            Product updates and practical writing on fire risk assessment from
            the Safentia team.
          </p>
        </Container>
      </Section>

      <Section spacing="tight">
        <Container prose>
          <ul className={styles.list}>
            {articles.map((article) => (
              <li key={article.slug} className={styles.item}>
                <article>
                  <p className={styles.meta}>
                    <time dateTime={new Date(article.publishAt).toISOString()}>
                      {dateFormat.format(new Date(article.publishAt))}
                    </time>
                    <span aria-hidden="true" className={styles.dot}>
                      &middot;
                    </span>
                    {article.readingMinutes} minute read
                  </p>
                  <h2 className={styles.itemTitle}>
                    <Link to={`/news/${article.slug}`} className={styles.itemLink}>
                      {article.title}
                    </Link>
                  </h2>
                  <p className={styles.summary}>{article.summary}</p>
                </article>
              </li>
            ))}
          </ul>
        </Container>
      </Section>
    </>
  );
}
