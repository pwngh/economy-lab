/**
 * @pwngh/economy-lab-docs
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { CardGrid } from '~/components/CardGrid.tsx';
import { docs, docsInSection } from '~/content.ts';
import { pageMeta } from '~/seo.ts';

export function meta() {
  return pageMeta({
    title: 'Ports & edges - Economy Lab',
    description:
      'The interfaces economy-lab depends on, the adapters that satisfy them, and what is out of scope.',
    path: '/economy/ports/',
  });
}

export default function PortsIndex() {
  const ports = docsInSection('ports').map((d) => d.slug);
  const scope = docs.filter((d) => d.slug === 'economy/scope-and-non-goals').map((d) => d.slug);
  return (
    <section className="prose">
      <h1>Ports &amp; edges</h1>
      <p className="doc-summary">
        The economy is the system of record; everything it talks to is a port you supply an adapter
        for.
      </p>
      <CardGrid slugs={[...ports, ...scope]} />
    </section>
  );
}
