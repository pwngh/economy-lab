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
    title: 'Ops & runbooks - economy-lab docs',
    description:
      'Running the economy in production: the in-process supervisor, the audit trail, backup and restore, key rotation, and one runbook per incident signature.',
    path: '/economy/ops/',
  });
}

const isRunbook = (slug: string) => slug.startsWith('economy/ops/runbooks/');

export default function OpsIndex() {
  const pages = docsInSection('ops')
    .filter((d) => !isRunbook(d.slug))
    .map((d) => d.slug);
  return (
    <section className="prose">
      <h1>Ops &amp; runbooks</h1>
      <p className="doc-summary">
        The supervisor watches the running economy through its own telemetry ports and remediates
        under guardrails; these pages are the operational surface around it, plus{' '}
        <a href="/economy/ops/runbooks/">one runbook per incident signature</a>.
      </p>
      <CardGrid slugs={pages} />
    </section>
  );
}
