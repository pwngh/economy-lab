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

import { pageMeta } from '~/seo.ts';

export function meta() {
  return pageMeta({ title: 'Not found - economy-lab docs', path: '/404/' });
}

// A console deep link (/console/market) has no file on a static host, so it lands here; stash the
// intended URL — search and hash included, bare /console normalized — and bounce to the console
// shell, whose entry restores it before the router boots. Hash-pinned in public/_headers like
// every inline script (see scripts/check-csp.mjs).
export const CONSOLE_BOUNCE = `(function(){var p=location.pathname;if(p==='/console')p='/console/';if(p.indexOf('/console/')===0){try{sessionStorage.setItem('elab_redirect',p+location.search+location.hash)}catch(e){}location.replace('/console/')}})()`;

/** Splat-route fallback, prerendered at /404 and published as the platform 404.html (see scripts/copy-404.mjs). */
export default function NotFound() {
  return (
    <article className="prose">
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static bounce script */}
      <script dangerouslySetInnerHTML={{ __html: CONSOLE_BOUNCE }} />
      <h1>Page not found</h1>
      <p>
        That page doesn't exist. Try the <a href="/economy/">economy overview</a>, the{' '}
        <a href="/economy/reference/">reference</a>, or the{' '}
        <a href="/economy/concepts/">concepts</a>.
      </p>
    </article>
  );
}
