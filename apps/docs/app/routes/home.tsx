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
  return pageMeta({
    title: 'Economy Lab Docs',
    description:
      'Reference documentation for Economy Lab — a double-entry credit economy that is provably solvent and tamper-evident.',
    path: '/',
  });
}

/** Site landing: a one-line orientation and a single door into the economy section. */
export default function Home() {
  return (
    <div className="prose">
      <h1>economy-lab documentation</h1>
      <p className="doc-summary">
        A double-entry credit economy that is provably solvent and tamper-evident — built to
        demonstrate correctness in systems that move money.
      </p>
      <p>
        All of the documentation lives under one section. Start at the{' '}
        <a href="/economy/">economy overview →</a>
      </p>
    </div>
  );
}
