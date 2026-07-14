/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * The X-ray hub: the reads this page's loader makes, recorded through one generic Proxy, plus a
 * live wire-operation runner and how a platform's API maps onto the ledger.
 */

import { useState } from 'react';

import { useFetcher } from 'react-router';

import type { SubmitTarget } from 'react-router';

import { getEngine } from '~/engine';
import { DataTable, PageError, pageMeta } from '~/ui';
import { recordCalls } from '~/xray';
import type { RecordedCall } from '~/xray';
import type { Route } from './+types/developers';

export function meta(args: Route.MetaArgs) {
  return pageMeta(
    args,
    'Developers',
    'The hood lifted: an X-ray of engine calls and a live wire-operation runner.',
  );
}

export async function clientLoader() {
  const calls: RecordedCall[] = [];
  const eco = recordCalls(await getEngine(), calls);
  // The reads a dashboard loader makes, run through the recorder so the page can show its own work.
  await Promise.all([
    eco.solvency(),
    eco.prove(),
    eco.wallets({ offset: 0, limit: 8 }),
    eco.status(),
    eco.checkpoint(),
  ]);
  return { calls };
}

const WIRE_EXAMPLE = `{
  "kind": "spend",
  "idempotencyKey": "idem_wire_1",
  "actor": { "kind": "user", "userId": "usr_alice" },
  "buyerId": "usr_alice",
  "sku": "Aurora Avatar",
  "price": "CREDIT:500.00",
  "recipients": [{ "sellerId": "usr_nova", "shareBps": 10000 }],
  "orderId": "ord_wire_1"
}`;

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

// The wire runner: one operation as JSON, posted to the mounted service, the raw wire response
// beside it. A committed run revalidates every loader, so the tickers and X-ray move with it.
function WireRunner() {
  const fetcher = useFetcher<{ status: number; body: unknown }>();
  const [text, setText] = useState(WIRE_EXAMPLE);
  const [parseError, setParseError] = useState<string | null>(null);
  const busy = fetcher.state !== 'idle';

  function run() {
    try {
      const op = JSON.parse(text) as SubmitTarget;
      setParseError(null);
      void fetcher.submit(op, {
        method: 'post',
        action: '/submit',
        encType: 'application/json',
      });
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Invalid JSON.');
    }
  }

  return (
    <div className="card">
      <div className="row between">
        <h3>Submit an operation over the wire</h3>
        <CopyButton text={text} />
      </div>
      <p className="card-sub">
        The engine also runs as an HTTP service — the same{' '}
        <span className="mono">createServer</span> it exposes standalone, here
        bound to your tab&apos;s economy. Run this operation through it and the
        wire response comes back verbatim; the tickers, Ledger, and the X-ray
        above revalidate on commit. Edit the JSON — a reused{' '}
        <span className="mono">orderId</span> replays as a duplicate.
      </p>
      <textarea
        className="curl mono wire-input"
        aria-label="Wire operation JSON"
        rows={10}
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
      />
      <div className="row between">
        <button type="button" className="primary" onClick={run} disabled={busy}>
          {busy ? 'Running…' : 'Run operation'}
        </button>
        {parseError ? <span className="field-error">{parseError}</span> : null}
      </div>
      {fetcher.data ? (
        <pre className="curl mono" aria-live="polite">
          {`HTTP ${fetcher.data.status}\n${JSON.stringify(fetcher.data.body, null, 2)}`}
        </pre>
      ) : null}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn small"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
      }}
      onMouseLeave={() => setCopied(false)}
      onBlur={() => setCopied(false)}
    >
      {copied ? '✓ copied' : 'Copy'}
    </button>
  );
}

export default function Developers({ loaderData }: Route.ComponentProps) {
  const { calls } = loaderData;

  return (
    <div className="page">
      <div className="view-head">
        <h2>Developers</h2>
        <p>What this is, how it fits inside a platform, and the hood lifted.</p>
      </div>

      <div className="card card-flush">
        <div className="card-head">
          <h3>X-ray — the engine calls this page makes</h3>
          <p className="card-sub">
            Every call this page&apos;s loader makes to the engine, recorded
            through one generic Proxy: the call, its arguments, the wall-clock
            time, and a summary of the result. Adding a facade method never
            touches the recorder.
          </p>
        </div>
        <DataTable
          columns={[
            { key: 'call', label: 'Call' },
            { key: 'result', label: 'Result' },
            { key: 'ms', label: 'Time', num: true },
          ]}
        >
          {calls.map((c) => (
            <tr key={c.id}>
              <td className="mono">
                <b>{c.name}</b>({c.args})
              </td>
              <td className="dim mono">{c.result}</td>
              <td className="num mono">{c.ms} ms</td>
            </tr>
          ))}
        </DataTable>
      </div>

      <WireRunner />

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
          lines up, so tampering is caught — what the Integrity page proves on
          every load, and what the ledger explorer walks link by link.
        </p>
      </div>

      <div className="card prose">
        <h3>Two layers, one source of truth</h3>
        <p>
          The platform you&apos;d build on top has a public economy API. It
          returns simple read models — a <span className="mono">Balance</span>,
          a <span className="mono">ProductPurchase</span>, a{' '}
          <span className="mono">License</span>. This console is the layer
          underneath: the proven double-entry ledger that produces those read
          models and guarantees they&apos;re correct.
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
          itself — it hands off at its edges: payouts to sellers and card
          deposits go through a payment partner (Tilia), and KYC, tax, and AML
          live in that money-transmitter partner by design, not here. The
          Pipeline page watches the events cross that edge.
        </p>
      </div>

      <div className="card card-flush">
        <div className="card-head">
          <h3>Endpoint map</h3>
          <p className="card-sub">
            Illustrative, not served here: the shape of the public economy API a
            platform would build on top, and the ledger operation each one
            drives underneath. The one wire route this console mounts is the
            runner above.
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

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <PageError error={error} />;
}
