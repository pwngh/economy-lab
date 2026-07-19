/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * The ledger explorer drill, over the promoted read surface (read.posting / read.statement /
 * read.lineage / read.checkpoint). Every level is a shareable URL: a posting at /ledger/txn/:id,
 * an account's statement + hash chain + checkpoint under ?account=. Nothing here reaches past the
 * engine's own read API.
 */

import { useState } from 'react';
import { Link } from 'react-router';

import { GENESIS_HEX } from '#src/store-kit.ts';

import { getEngine } from '~/engine';
import {
  Amount,
  Credits,
  DataTable,
  IdChip,
  PageError,
  StatusPill,
  Usd,
  dayLabel,
  pageMeta,
  withLegKeys,
} from '~/ui';
import type { Route } from './+types/ledger.txn.$id';

export function meta(args: Route.MetaArgs) {
  return pageMeta(
    args,
    'Posting',
    'One balanced posting in full: its legs, the accounts they touch, and its place in the hash chain.',
  );
}

export async function clientLoader({
  params,
  request,
}: Route.ClientLoaderArgs) {
  const eco = await getEngine();
  const account = new URL(request.url).searchParams.get('account');
  const [posting, statement, lineage, checkpoint] = await Promise.all([
    eco.posting(params.id),
    account ? eco.statement(account) : Promise.resolve(null),
    account ? eco.lineage(account) : Promise.resolve(null),
    account ? eco.checkpoint() : Promise.resolve(null),
  ]);
  return { txnId: params.id, account, posting, statement, lineage, checkpoint };
}

// A 64-hex hash, shown as its first and last few characters with the full value copyable. Flips to
// a copied confirmation on click, resetting on leave, so the copy is confirmed sighted and aloud.
function Hash({ value }: { value: string }) {
  const short =
    value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="hash mono"
      title={`${value} — click to copy`}
      aria-label={copied ? `Copied hash ${short}` : `Copy hash ${short}`}
      onClick={() => {
        void navigator.clipboard?.writeText(value);
        setCopied(true);
      }}
      onMouseLeave={() => setCopied(false)}
      onBlur={() => setCopied(false)}
    >
      {copied ? '✓ copied' : short}
    </button>
  );
}

export default function TxnDetail({ loaderData }: Route.ComponentProps) {
  const { txnId, account, posting, statement, lineage, checkpoint } =
    loaderData;
  return (
    <div className="page">
      <div className="view-head">
        <h2>
          Posting <span className="mono head-id">{txnId}</span>
        </h2>
        <p>
          <Link to="/ledger" className="link">
            ← Back to the ledger
          </Link>
        </p>
      </div>

      {posting === null ? (
        <div className="notice err">No posting with that id.</div>
      ) : (
        <div className="card card-flush">
          <div className="card-head">
            <h3>
              {posting.label}{' '}
              {posting.balancedTo === 0 ? (
                <StatusPill tone="green">balanced</StatusPill>
              ) : (
                <StatusPill tone="red">≠ {posting.balancedTo}</StatusPill>
              )}
            </h3>
            <p className="card-sub">
              Each leg is one side of the double entry. Follow an account into
              its statement, its hash chain, and the checkpoint that seals it.
            </p>
          </div>
          <DataTable
            columns={[
              { key: 'account', label: 'Account' },
              { key: 'side', label: 'Side' },
              { key: 'amount', label: 'Amount', num: true },
            ]}
          >
            {withLegKeys(posting.legs).map(({ leg, key }) => (
              <tr key={key}>
                <td>
                  <Link
                    to={`?account=${encodeURIComponent(leg.account)}`}
                    preventScrollReset
                    viewTransition
                    className="link"
                  >
                    {leg.label}
                  </Link>
                </td>
                <td>
                  <StatusPill tone={leg.side === 'debit' ? 'red' : 'green'}>
                    {leg.side}
                  </StatusPill>
                </td>
                <td className="num">
                  <Amount num={leg.amount} suf={leg.currency} />
                </td>
              </tr>
            ))}
          </DataTable>
        </div>
      )}

      {account && statement ? (
        <div className="card card-flush account-drill">
          <div className="card-head">
            <div className="row between">
              <h3>
                {statement.label} <IdChip id={account} />
              </h3>
              <span className="stat-value drill-balance">
                {statement.currency === 'USD' ? (
                  <Usd value={statement.balance} />
                ) : (
                  <Credits value={statement.balance} />
                )}
              </span>
            </div>
            <p className="card-sub">
              Its statement, its tamper-evident hash chain, and the latest
              signed checkpoint — the whole drill from a balance to the proof
              behind it.
            </p>
          </div>

          <div className="drill-section">
            <div className="sb-title">Statement</div>
            {statement.entries.length === 0 ? (
              <div className="empty">No postings touched this account.</div>
            ) : (
              <DataTable
                columns={[
                  { key: 'txn', label: 'Posting' },
                  { key: 'when', label: 'When' },
                  { key: 'amount', label: 'Amount', num: true },
                ]}
              >
                {statement.entries.map((e) => (
                  <tr key={e.txnId}>
                    <td>
                      <Link to={`/ledger/txn/${e.txnId}`} className="link mono">
                        {e.txnId}
                      </Link>
                    </td>
                    <td className="dim">{dayLabel(e.at)}</td>
                    <td className="num">
                      {statement.currency === 'USD' ? (
                        <Usd value={e.credits} />
                      ) : (
                        <Credits value={e.credits} />
                      )}
                    </td>
                  </tr>
                ))}
              </DataTable>
            )}
          </div>

          <div className="drill-section">
            <div className="sb-title">Hash chain</div>
            <ol className="chain">
              {(lineage ?? []).map((link) => (
                <li key={link.txnId} className="chain-link">
                  <Link to={`/ledger/txn/${link.txnId}`} className="link mono">
                    {link.txnId}
                  </Link>
                  <span className="chain-hashes">
                    {link.prevHash === GENESIS_HEX ? (
                      <span className="dim small">genesis</span>
                    ) : (
                      <Hash value={link.prevHash} />
                    )}
                    <span aria-hidden="true"> → </span>
                    <Hash value={link.hash} />
                  </span>
                </li>
              ))}
            </ol>
            <div className="sb-note">
              Each link&apos;s <span className="mono">prevHash</span> is the{' '}
              <span className="mono">hash</span> of the one before it; change
              any old posting and the chain no longer lines up.
            </div>
          </div>

          <div className="drill-section">
            <div className="sb-title">Latest checkpoint</div>
            {checkpoint === null ? (
              <div className="empty">
                No checkpoint sealed yet. Run jobs to seal one.
              </div>
            ) : (
              <dl className="checkpoint">
                <div className="figure">
                  <dt>Merkle root</dt>
                  <dd>
                    <Hash value={checkpoint.root} />
                  </dd>
                </div>
                <div className="figure">
                  <dt>Signature</dt>
                  <dd>
                    <Hash value={checkpoint.signature} />
                  </dd>
                </div>
                <div className="figure">
                  <dt>Heads covered</dt>
                  <dd className="mono">{checkpoint.count}</dd>
                </div>
                <div className="figure">
                  <dt>Sealed</dt>
                  <dd className="mono">{dayLabel(checkpoint.at)}</dd>
                </div>
              </dl>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <PageError error={error} />;
}
