// ============================================================================
// The route table. One table serves both the pre-render pass and the browser.
//
// Public pages are imported statically: they are small, they must exist at build
// time for the pre-render, and they share one chunk that a first-time visitor
// downloads once. The signed-in console is LAZY, because it pulls in the Firebase
// Web SDK and a marketing visitor must never pay for that.
//
// `/app` is pre-rendered too, but only as the splash the AuthProvider shows while
// it resolves the first ID token. Firebase Hosting rewrites every `/app/**` URL to
// that shell (firebase.json), so a deep link into the console hydrates from a
// loading state rather than flashing the marketing home page first.
//
// Adding a public route means adding it here AND to sitemap generation. The
// sitemap is derived from this table, so the two cannot drift.
// ============================================================================

import type { RouteRecord } from 'vite-react-ssg';

import { PublicLayout } from './layouts/PublicLayout';
import { HomePage } from './pages/Home';
import { HowItWorksPage } from './pages/HowItWorks';
import { AboutPage } from './pages/About';
import { FaqPage } from './pages/Faq';
import { ContactPage } from './pages/Contact';
import { NewsIndexPage } from './pages/news/NewsIndex';
import { NewsArticlePage } from './pages/news/NewsArticle';
import { PrivacyPage } from './pages/legal/Privacy';
import { TermsPage } from './pages/legal/Terms';
import { NotFoundPage } from './pages/NotFound';
import { publishedArticleSlugs } from './content/news';


export const routes: RouteRecord[] = [
  {
    path: '/',
    element: <PublicLayout />,
    entry: 'src/layouts/PublicLayout.tsx',
    children: [
      { index: true, element: <HomePage /> },
      { path: 'how-it-works', element: <HowItWorksPage /> },
      { path: 'about', element: <AboutPage /> },
      { path: 'faq', element: <FaqPage /> },
      { path: 'contact', element: <ContactPage /> },
      { path: 'news', element: <NewsIndexPage /> },
      {
        path: 'news/:slug',
        element: <NewsArticlePage />,
        // Enumerates one HTML file per published article, so every post is
        // indexable without JavaScript (story 2073 AC2).
        getStaticPaths: () => publishedArticleSlugs().map((slug) => `/news/${slug}`),
      },
      { path: 'legal/privacy', element: <PrivacyPage /> },
      { path: 'legal/terms', element: <TermsPage /> },
      // A real /404 route exists so the pre-render emits dist/404.html, which
      // Firebase Hosting serves for any URL no rewrite matches. Without it a
      // mistyped URL gets Hosting's stock error page, not ours.
      { path: '404', element: <NotFoundPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },

  // --- Authentication. Its own layout: no site nav, no footer links to wander
  // off into, and noindex. Pre-rendered so the sign-in page paints instantly.
  {
    path: 'login',
    lazy: () => import('./features/auth/LoginRoute'),
    entry: 'src/features/auth/LoginRoute.tsx',
  },
  {
    path: 'signup',
    lazy: () => import('./features/auth/SignupRoute'),
    entry: 'src/features/auth/SignupRoute.tsx',
  },
  {
    path: 'forgot-password',
    lazy: () => import('./features/auth/ForgotPasswordRoute'),
    entry: 'src/features/auth/ForgotPasswordRoute.tsx',
  },
  // Invitation acceptance: the invite email's web link lands here with its
  // bearer token in the query string. Public, pre-rendered and noindex, so it
  // never appears in the sitemap (scripts/generate-sitemap.mjs skips noindex).
  {
    path: 'invite',
    lazy: () => import('./features/invite/InviteRoute'),
    entry: 'src/features/invite/InviteRoute.tsx',
  },

  // --- The signed-in console. See the header note on the /app/** rewrite.
  {
    path: 'app',
    lazy: () => import('./console/ConsoleRoute'),
    entry: 'src/console/ConsoleRoute.tsx',
  },
  {
    path: 'app/*',
    lazy: () => import('./console/ConsoleRoute'),
    entry: 'src/console/ConsoleRoute.tsx',
  },
];
