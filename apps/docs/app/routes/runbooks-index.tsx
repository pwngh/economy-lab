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
    title: 'Runbooks - economy-lab docs',
    description:
      'One runbook per supervisor signature: symptoms, detection, the automatic response, manual steps, and escalation.',
    path: '/economy/ops/runbooks/',
  });
}

export default function RunbooksIndex() {
  const slugs = docs.filter((d) => d.slug.startsWith('economy/ops/runbooks/')).map((d) => d.slug);
  return (
    <section className="prose">
      <h1>Runbooks</h1>
      <p className="doc-summary">
        One page per <code>SignatureName</code>, in the same shape: symptoms, detection (exact
        metrics and thresholds), what the supervisor already did, the manual steps, and when to
        escalate.
      </p>
      <CardGrid slugs={slugs} />
    </section>
  );
}
