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
  return pageMeta({ title: 'Not found - Economy Lab', path: '/404/' });
}

/** In-app fallback for unmatched client navigation. Cold server requests are served public/404.html first. */
export default function NotFound() {
  return (
    <article className="prose">
      <h1>Page not found</h1>
      <p>
        That page doesn't exist. Try the{' '}
        <a href="/economy/">economy overview</a>, the{' '}
        <a href="/economy/reference/">reference</a>, or the{' '}
        <a href="/economy/concepts/">concepts</a>.
      </p>
    </article>
  );
}
