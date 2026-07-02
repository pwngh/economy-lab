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

import { CardGrid } from '~/components/CardGrid.tsx';
import { docs } from '~/content.ts';
import { pageMeta } from '~/seo.ts';

export function meta() {
  return pageMeta({
    title: 'Reference - economy-lab docs',
    description:
      'Every operation, the read surface, outcomes and reason codes, the HTTP service, and configuration.',
    path: '/economy/reference/',
  });
}

export default function ReferenceIndex() {
  const pages = docs
    .filter((d) => d.section === 'reference' && !d.slug.startsWith('economy/reference/operations/'))
    .map((d) => d.slug);

  return (
    <section className="prose">
      <h1>Reference</h1>
      <p className="doc-summary">
        The exhaustive surface: what each call does, what it returns, and how it is configured.
      </p>

      <h2>Operations</h2>
      <p>
        Every state-changing call is one <code>Operation</code>, submitted through the same gate.{' '}
        <a href="/economy/reference/operations/">Browse all operations →</a>
      </p>

      <h2>Reads &amp; configuration</h2>
      <CardGrid slugs={pages} />
    </section>
  );
}
