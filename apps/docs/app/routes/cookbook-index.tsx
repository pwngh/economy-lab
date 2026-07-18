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
    title: 'Cookbook - economy-lab docs',
    description:
      'Short, copy-pasteable patterns: a promo with an expiry, an entitlement-gated feature, a marketplace fee split, and scheduled top-ups. Every snippet runs live.',
    path: '/economy/cookbook/',
  });
}

export default function CookbookIndex() {
  const pages = docsInSection('cookbook').map((d) => d.slug);
  return (
    <section className="prose">
      <h1>Cookbook</h1>
      <p className="doc-summary">
        Short patterns you can lift whole: each recipe is a page of prose around a runnable snippet,
        exercised in CI exactly as shown.
      </p>
      <CardGrid slugs={pages} />
    </section>
  );
}
