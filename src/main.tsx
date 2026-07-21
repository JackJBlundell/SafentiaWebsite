// ============================================================================
// Entry point.
//
// `ViteReactSSG` serves two masters from one route table: at build time it walks
// the routes and writes a real HTML file for each public page (story 2075 AC1),
// and in the browser it hydrates that HTML into the running single-page app. The
// console at /app/** is excluded from pre-rendering - its content depends on who
// is signed in - and is served from its own pre-rendered shell via a Hosting
// rewrite, so it hydrates into the splash rather than flashing the home page.
// ============================================================================

import { ViteReactSSG } from 'vite-react-ssg';
import { routes } from './routes';

import './design/fonts.css';
import './design/tokens.css';
import './design/global.css';

export const createRoot = ViteReactSSG({ routes });
