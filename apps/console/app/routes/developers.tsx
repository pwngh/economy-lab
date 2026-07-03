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

import type { Route } from './+types/developers';
import { DataTable } from '~/ui';

// No loader: static developer copy.
export function meta(_: Route.MetaArgs) {
  return [{ title: 'Developers — Economy Console' }];
}

const ENDPOINTS: [string, string][] = [
  ['Read a wallet balance', 'GET /user/{id}/balance → Balance'],
  ['Read payout-eligible earnings', 'GET /user/{id}/balance/earnings'],
  ['Check account gates', 'GET /user/{id}/economy/account → EconomyAccount'],
  ['Buy a listing', 'POST /economy/purchase/listing → ProductPurchase'],
  ['List a user’s purchases', 'GET /economy/purchases'],
  ['Active entitlements', 'GET /economy/licenses/active → License[]'],
  ['Buy Credits (deposit)', 'GET /tokenBundles → bundle purchase'],
  ['Subscriptions', 'GET /auth/user/subscription → UserSubscription[]'],
  ['Payment-partner status', 'GET /tilia/status → TiliaStatus'],
  ['Payout eligibility', '/credits/eligible + tilia/tos + earnings ≥ min'],
  ['Dispute / chargeback', 'Transaction.status: chargeback → reversal'],
];

export default function Developers() {
  return (
    <div className="page">
      <div className="view-head">
        <h2>Developers</h2>
        <p>What this is, and how it fits inside a platform.</p>
      </div>

      <div className="card prose">
        <h3>What the ledger is</h3>
        <p className="lede">
          A ledger is the official record of where every Credit is.
        </p>
        <p>
          It is double-entry. Every movement posts two matching sides — a debit
          and a credit — that always net to zero. Money is never created or
          destroyed; it only moves from one account to another.
        </p>
        <p>
          Each posting is also hash-chained: it is sealed with a hash built from
          the one before it. Change any old posting and the chain no longer
          lines up, so tampering is caught — that is what the Integrity page
          proves on every load.
        </p>
      </div>

      <div className="card prose">
        <h3>How this console works</h3>
        <p>
          Every figure on these pages is read live from the ledger. When you
          record an operation, advance time, or run jobs, the books update and
          the page reflects the new state.
        </p>
        <ul>
          <li>
            <b>The ledger is the source of truth.</b> Wallets, balances,
            payouts, and the integrity report all come from it.
          </li>
          <li>
            <b>Your changes persist.</b> A browser refresh keeps the current
            state. Reset rebuilds and re-seeds; Clear empties it.
          </li>
        </ul>
      </div>

      <div className="card prose">
        <h3>Two layers, one source of truth</h3>
        <p>
          The platform you&apos;d build on top has a public economy API. It
          returns simple read models — a <span className="mono">Balance</span>,
          a <span className="mono">ProductPurchase</span>, a{' '}
          <span className="mono">License</span>.
        </p>
        <p>
          This console is the layer underneath: the proven double-entry ledger
          that produces those read models and guarantees they&apos;re correct.
        </p>
        <ul>
          <li>
            <b>The public read-model API</b> answers &quot;how much does this
            user have?&quot; with a single number.
          </li>
          <li>
            <b>The ledger underneath</b> is where that number comes from — every
            debit and credit, proven conserved, backed, and hash-chained.
          </li>
        </ul>
        <p>
          The number on top is only trustworthy because the ledger below it can
          prove it. That proof is the whole point.
        </p>
      </div>

      <div className="card prose">
        <h3>Where it hands off to external rails</h3>
        <p>
          The ledger records money movement. It does not move real-world money
          itself — it hands off at its edges:
        </p>
        <ul>
          <li>
            <b>Payouts to sellers</b> go out through a payment partner (Tilia).
            The ledger reserves the credits; the partner moves the USD. The
            Payouts page tracks each one from reserve to settlement.
          </li>
          <li>
            <b>Deposits</b> come in the same way: the partner takes the card
            payment, the ledger records the resulting Credits.
          </li>
          <li>
            <b>KYC, tax, and AML</b> live in that money-transmitter partner by
            design, not here.
          </li>
        </ul>
        <p>
          So the ledger is the system of record in the middle: it knows what is
          owed and proves the books balance, while the external rails handle the
          real cash.
        </p>
      </div>

      <div className="card card-flush">
        <div className="card-head">
          <h3>Endpoint map</h3>
          <p className="card-sub">
            How a platform&apos;s economy API maps onto this ledger.
          </p>
        </div>
        <DataTable
          columns={[
            { key: 'action', label: 'Platform action' },
            { key: 'endpoint', label: 'API endpoint' },
          ]}
        >
          {ENDPOINTS.map(([a, b]) => (
            <tr key={a}>
              <td>{a}</td>
              <td className="muted mono small">{b}</td>
            </tr>
          ))}
        </DataTable>
      </div>
    </div>
  );
}
