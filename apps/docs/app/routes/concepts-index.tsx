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
import { docsInSection } from '~/content.ts';
import { pageMeta } from '~/seo.ts';

export function meta() {
  return pageMeta({
    title: 'Concepts - economy-lab docs',
    description:
      'The ideas the economy is built on: the money model, accounts, solvency, the payout saga, and integrity.',
    path: '/economy/concepts/',
  });
}

export default function ConceptsIndex() {
  const slugs = docsInSection('concepts').map((d) => d.slug);
  return (
    <section className="prose">
      <h1>Concepts</h1>
      <p className="doc-summary">
        The ideas the economy is built on — read top to bottom for the full picture.
      </p>
      <CardGrid slugs={slugs} />
    </section>
  );
}
