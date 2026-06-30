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
    title: 'Operations - Economy Lab',
    description: 'Every state-changing operation in the economy, one page each.',
    path: '/economy/reference/operations/',
  });
}

export default function OperationsIndex() {
  const slugs = docs
    .filter((d) => d.slug.startsWith('economy/reference/operations/'))
    .map((d) => d.slug);
  return (
    <section className="prose">
      <h1>Operations</h1>
      <p className="doc-summary">
        Every state-changing call is a kind-tagged <code>Operation</code> that posts a balanced
        transaction and returns an <code>Outcome</code>.
      </p>
      <CardGrid slugs={slugs} />
    </section>
  );
}
