/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useMatches,
} from 'react-router';

import type { ReactNode } from 'react';
import type { LinksFunction } from 'react-router';

import { Sidebar } from '~/components/Sidebar.tsx';

import '~/app.css';

/**
 * No-flash theme bootstrap, inlined in <head> and run before first paint. A plain string, not a
 * React handler, so `data-theme` is set before the body paints. The try/catch guards localStorage
 * throwing under blocked cookies or private mode. (Kept byte-identical to the toggle's counterpart
 * in preston-neal.com so the CSP hash is shared and verifiable.)
 */
const THEME_INIT = `(function(){try{var t=localStorage.getItem('theme')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.dataset.theme=t;}catch(e){}})();`;

/**
 * Theme toggle: one delegated click listener, as a vanilla string so it keeps working on pages that
 * ship no JavaScript bundle. The preference is written back to localStorage so it survives a reload.
 */
const THEME_TOGGLE = `document.addEventListener('click',function(e){var b=e.target.closest('[data-theme-toggle]');if(!b)return;var d=document.documentElement,n=d.dataset.theme==='dark'?'light':'dark';d.dataset.theme=n;try{localStorage.setItem('theme',n);}catch(e){}});`;

/**
 * Keep the sidebar's active item in view. Each page is its own document (no client router), so the
 * sidebar reloads at scroll 0 every navigation. Rather than save/restore a scroll position — which is
 * non-deterministic once prerendering and view transitions are in play, and was making the sidebar
 * jump around — this is stateless and deterministic: scroll the sidebar only if the current page's
 * link (the [aria-current] item) is not already visible, positioning it a third from the top. It runs
 * before paint (this <script> sits right after the sidebar), so there is no visible movement, and the
 * result depends only on which page you are on — so it cannot jump randomly. Navigating between items
 * that are both already visible moves nothing at all.
 */
const SIDEBAR_REVEAL = `(function(){var sb=document.querySelector('.site-sidebar');if(!sb)return;var c=sb.querySelector('[aria-current="page"]');if(!c)return;var sr=sb.getBoundingClientRect(),cr=c.getBoundingClientRect();if(cr.top<sr.top||cr.bottom>sr.bottom){sb.scrollTop+=cr.top-sr.top-sb.clientHeight/3;}})();`;

/**
 * Speculate on intent — declaratively, no executable JS we wrote. A Speculation Rules document rule
 * that prerenders (not just prefetches) any same-origin /economy/* link on hover/focus ("moderate"
 * eagerness): the browser renders the next page fully in the background, so a click activates it
 * instantly. `not selector_matches "[aria-current]"` excludes the link to the page you're already on
 * (the active sidebar/nav item), so the current page is never re-speculated. JSON the browser reads,
 * not a script we run — the page still ships zero executable JS. Chromium-only and ignored elsewhere,
 * so it degrades to plain navigation. Allowed by the CSP `'inline-speculation-rules'` source.
 */
const SPECULATION_RULES = `{"prerender":[{"source":"document","where":{"and":[{"href_matches":"/economy/*"},{"not":{"selector_matches":"[aria-current]"}}]},"eagerness":"moderate"}]}`;

export const links: LinksFunction = () => [
  { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
];

/**
 * Root document shell. Zero client React by default: <Scripts/> and <ScrollRestoration/> render only
 * when a matched route opts into hydration via handle.hydrate (none do), so content pages ship no
 * bundle. The header carries what the sidebar can't — search — plus the GitHub and theme controls;
 * primary navigation lives entirely in the sidebar, so it is not duplicated up here.
 */
export function Layout({ children }: { children: ReactNode }) {
  const matches = useMatches();
  const hydrate = matches.some((m) => (m.handle as { hydrate?: boolean } | undefined)?.hydrate);

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" media="(prefers-color-scheme: light)" content="#fbfaf6" />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#15171c" />
        <Meta />
        <Links />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: fixed author-controlled string, not user input; its SHA-256 is pinned in the CSP */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <header className="site-header">
          <a className="wordmark" href="/">
            economy-lab<span className="accent"> / docs</span>
          </a>
          <div className="site-tools">
            <search className="site-search">
              <input
                id="site-search-input"
                className="search-input"
                type="search"
                placeholder="Search docs…"
                aria-label="Search documentation"
                aria-controls="site-search-results"
                aria-expanded="false"
                autoComplete="off"
              />
              <div
                id="site-search-results"
                className="search-results"
                role="listbox"
                aria-label="Search results"
                tabIndex={-1}
                hidden
              />
            </search>
            <a
              className="icon-link"
              href="https://github.com/pwngh/economy-lab"
              target="_blank"
              rel="noopener noreferrer"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
              </svg>
              <span className="sr-only">GitHub</span>
            </a>
            <button
              type="button"
              className="theme-toggle"
              data-theme-toggle
              aria-label="Toggle color theme"
            >
              ◐
            </button>
          </div>
        </header>

        <div className="site-shell">
          <aside className="site-sidebar">
            <Sidebar />
          </aside>
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: fixed author-controlled string, not user input; its SHA-256 is pinned in the CSP. Sits right after the sidebar so the active item is revealed before paint. */}
          <script dangerouslySetInnerHTML={{ __html: SIDEBAR_REVEAL }} />
          {/* tabIndex={-1} lets the skip link move keyboard focus into the content region. */}
          <main id="main" className="site-main" tabIndex={-1}>
            {children}
          </main>
        </div>

        <footer className="site-footer">
          <p className="muted">
            Documentation for{' '}
            <a
              href="https://github.com/pwngh/economy-lab"
              target="_blank"
              rel="noopener noreferrer"
            >
              economy-lab
            </a>{' '}
            — correctness in systems that move money.
          </p>
          <p className="muted">Built with React Router, prerendered to static HTML.</p>
        </footer>

        {hydrate ? <ScrollRestoration /> : null}
        {hydrate ? <Scripts /> : null}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: fixed author-controlled string, not user input; its SHA-256 is pinned in the CSP */}
        <script dangerouslySetInnerHTML={{ __html: THEME_TOGGLE }} />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: declarative Speculation Rules JSON (not executable JS); allowed by the CSP 'inline-speculation-rules' source */}
        <script type="speculationrules" dangerouslySetInnerHTML={{ __html: SPECULATION_RULES }} />
        {/* Client search: a small deferred vanilla script (no framework) — the one interactive feature, loaded on every page but non-blocking. Allowed by script-src 'self'. */}
        <script src="/search.js" defer />
      </body>
    </html>
  );
}

/** Root route: a pass-through to the matched child via <Outlet/>; all document chrome lives in Layout. */
export default function App() {
  return <Outlet />;
}

/** Root error boundary. A recognized route response shows its status; anything unexpected collapses to a generic line so internal detail never reaches the page. */
export function ErrorBoundary({ error }: { error: unknown }) {
  const title = isRouteErrorResponse(error)
    ? `${error.status} — ${error.statusText}`
    : 'Something went wrong';
  return (
    <article className="prose">
      <h1>{title}</h1>
      <p>
        <a href="/">← Back to the docs</a>
      </p>
    </article>
  );
}
