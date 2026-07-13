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
} from 'react-router';

import type { ReactNode } from 'react';
import type { LinksFunction } from 'react-router';
import type { Route } from './+types/root';
import './app.css';

export const links: LinksFunction = () => [
  { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
];

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Economy Console</title>
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
        <a className="link" href="/">
          Back to overview
        </a>
      </p>
    </main>
  );
}
