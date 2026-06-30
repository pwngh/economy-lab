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
    title: 'Economy - Economy Lab',
    description:
      'The economy: a double-entry credit economy that is provably solvent and tamper-evident. Concepts, reference, and ports.',
    path: '/economy/',
  });
}

/** The economy section hub: a short orientation plus the sub-sections. */
export default function EconomyIndex() {
  return (
    <div className="prose">
      <h1>Economy</h1>
      <p className="doc-summary">
        A double-entry credit economy that is provably solvent and
        tamper-evident — built to demonstrate correctness in systems that move
        money.
      </p>
      <p>
        economy-lab is a library, not a product: every balance is a posting in a
        balanced ledger, real funds held in trust back users' spendable credits
        at par, and a per-account hash chain makes any altered history
        detectable. New here? Start with{' '}
        <a href="/economy/concepts/overview/">the overview</a>.
      </p>

      <ul className="card-grid">
        <li className="doc-card">
          <h3>
            <a href="/economy/concepts/">Concepts</a>
          </h3>
          <p>
            The money model, accounts and double-entry, solvency, lifecycles,
            integrity, and the proof.
          </p>
        </li>
        <li className="doc-card">
          <h3>
            <a href="/economy/reference/">Reference</a>
          </h3>
          <p>
            Every operation, the read surface, outcomes and reason codes, the
            HTTP service, and configuration.
          </p>
        </li>
        <li className="doc-card">
          <h3>
            <a href="/economy/ports/">Ports &amp; edges</a>
          </h3>
          <p>
            The interfaces economy-lab depends on — signer, processor, rates,
            pricing, storage and messaging — and what is out of scope.
          </p>
        </li>
      </ul>
    </div>
  );
}
