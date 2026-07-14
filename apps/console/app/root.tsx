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
  Link,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
} from 'react-router';

import type { ReactNode } from 'react';
import type { LinksFunction } from 'react-router';
import type { Route } from './+types/root';
import './app.css';

export const links: LinksFunction = () => [
  // BASE_URL-prefixed: the app serves from /console/, and a plain link would resolve on the docs
  // side of the site.
  {
    rel: 'icon',
    href: `${import.meta.env.BASE_URL}favicon.svg`,
    type: 'image/svg+xml',
  },
];

// Theme and actor live in localStorage — the app is a tab-local sandbox, so preferences are too.
// The theme key is 'theme', the same one the docs read, so a preference set on either surface
// carries across the whole site. No actor means "natural": each market form submits as its own
// buyer or seller, so the gates (including the actor-sensitive pause and authorization) fire by
// default; the switcher sets an explicit override.
export function clientLoader() {
  const theme = localStorage.getItem('theme');
  const actor = localStorage.getItem('elab_actor');
  return {
    theme: theme === 'light' || theme === 'dark' ? theme : null,
    actor:
      actor !== null && /^(usr_[a-z0-9_]+|operator|system)$/.test(actor)
        ? actor
        : null,
  };
}

// Applies the stored theme before first paint. The script owns the theme-* classes on <html>
// (React never renders them), so hydration cannot clobber the palette back to auto while loaders
// run.
const THEME_BOOT = `try{var t=localStorage.getItem('theme');if(t==='light'||t==='dark')document.documentElement.classList.add('theme-'+t)}catch(e){}`;

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Economy Console</title>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static theme boot script */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

// Shown while the engine builds and seeds — the moment between the static shell and the first
// loader render.
export function HydrateFallback() {
  return (
    <main className="boot">
      <p>Building your sandbox economy…</p>
    </main>
  );
}

export default function App() {
  return <Outlet />;
}

// Render a message instead of a blank page.
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = 'Something went wrong';
  let detail = 'This page could not be loaded. Please try again.';
  if (isRouteErrorResponse(error)) {
    title = `${error.status} ${error.statusText}`;
    detail = error.data ?? detail;
  } else if (error instanceof Error) {
    detail = error.message;
  }
  return (
    <main className="error-page">
      <div className="view-head">
        <h2>{title}</h2>
      </div>
      <div className="notice err">{detail}</div>
      <p>
        <Link className="link" to="/">
          Back to overview
        </Link>
      </p>
    </main>
  );
}
