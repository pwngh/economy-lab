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

/** Splat-route fallback for dev and prerender completeness. Cold requests on the deployed site are served public/404.html. */
export default function NotFound() {
  return (
    <article className="prose">
      <h1>Page not found</h1>
      <p>
        That page doesn't exist. Try the <a href="/economy/">economy overview</a>, the{' '}
        <a href="/economy/reference/">reference</a>, or the{' '}
        <a href="/economy/concepts/">concepts</a>.
      </p>
    </article>
  );
}
