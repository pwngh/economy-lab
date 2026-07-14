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

import { Fragment } from 'react';
import { Form, Link, useSearchParams } from 'react-router';

import { PAGE_SIZE } from '~/economy';
import type { FindHit } from '~/economy';
import { getEngine } from '~/engine';
import {
  Amount,
  Credits,
  DataTable,
  PageError,
  Pager,
  StatusPill,
  Usd,
  dayLabel,
  entityName,
  pageMeta,
  pageOffset,
  withLegKeys,
} from '~/ui';
import type { Route } from './+types/ledger';

type Txn = Route.ComponentProps['loaderData']['page']['rows'][number];

export function meta(_: Route.MetaArgs) {
  return pageMeta(
    'Ledger',
    'Every movement is a balanced, hash-chained posting; search any id, account, or hash.',
  );
}

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const eco = await getEngine();
  const offset = pageOffset(request.url, PAGE_SIZE);
  const query = (new URL(request.url).searchParams.get('q') ?? '').trim();
  const hit = query ? await eco.find(query) : null;
  return { page: await eco.ledger({ offset, limit: PAGE_SIZE }), query, hit };
}

function dayHeading(at: number) {
  const d = dayLabel(at);
  return d.charAt(0).toUpperCase() + d.slice(1);
}

// Type-tag tone per row: money in blue, a sale green, the payout lifecycle amber→green→red. A fee
// sweep is left neutral.
const KIND_TONE: Record<string, 'blue' | 'green' | 'amber' | 'red'> = {
  topUp: 'blue',
  spend: 'green',
  requestPayout: 'amber',
  grantPromo: 'blue',
  payoutSettled: 'green',
  payoutCash: 'green',
  payoutReversed: 'red',
  promoExpiry: 'amber',
};

// A truncated hash for display: first 8 and last 6 of a 64/128-hex value.
function shortHash(h: string): string {
  return h.length > 16 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h;
}

// What a ledger search resolved to — a posting, an account, a chain link, or the checkpoint — or a
// clean miss. Every hit links into the drill where that value lives.
function SearchResult({ query, hit }: { query: string; hit: FindHit | null }) {
  if (hit === null) {
    return (
      <div className="card search-result">
        <span className="dim">
          No match for <span className="mono">{query}</span>. Try a txn id, an
          account, a chain hash, the Merkle root, or a checkpoint signature.
        </span>
      </div>
    );
  }
  if (hit.kind === 'checkpoint') {
    const cp = hit.checkpoint;
    return (
      <div className="card search-result">
        <StatusPill tone="blue">Checkpoint · {hit.field}</StatusPill>
        <dl className="checkpoint mt-2">
          <div className="figure">
            <dt>Merkle root</dt>
            <dd className="mono">{shortHash(cp.root)}</dd>
          </div>
          <div className="figure">
            <dt>Signature</dt>
            <dd className="mono">{shortHash(cp.signature)}</dd>
          </div>
          <div className="figure">
            <dt>Heads covered</dt>
            <dd className="mono">{cp.count}</dd>
          </div>
          <div className="figure">
            <dt>Sealed</dt>
            <dd className="mono">{dayLabel(cp.at)}</dd>
          </div>
        </dl>
      </div>
    );
  }
  const to =
    hit.kind === 'txn'
      ? `/ledger/txn/${hit.txnId}`
      : `/ledger/txn/${hit.txnId}?account=${encodeURIComponent(hit.account)}`;
  const label =
    hit.kind === 'txn'
      ? 'Posting'
      : hit.kind === 'account'
        ? 'Account'
        : `Chain hash · ${hit.field}`;
  return (
    <div className="card search-result">
      <StatusPill tone="blue">{label}</StatusPill>{' '}
      <Link to={to} className="link mono">
        {hit.kind === 'account' ? hit.account : hit.txnId}
      </Link>
      {hit.kind === 'link' ? (
        <span className="dim"> on {hit.account}</span>
      ) : null}
    </div>
  );
}

// The ledger feed: every committed posting, newest first, grouped by day and expandable to its
// legs. The open row lives in the URL (`?open=<txnId>`), so expansion needs no JavaScript and an
// expanded posting is a shareable address.
export default function Ledger({ loaderData }: Route.ComponentProps) {
  const { page, query, hit } = loaderData;
  const { rows: txns, offset, limit, total } = page;
  const [searchParams] = useSearchParams();
  const open = searchParams.get('open');

  function toggleHref(id: string): string {
    const params = new URLSearchParams(searchParams);
    if (open === id) {
      params.delete('open');
    } else {
      params.set('open', id);
    }
    const qs = params.toString();
    return qs ? `?${qs}` : '?';
  }

  // Rows are already newest-first; gather consecutive rows of the same day under one dated heading.
  const groups: { day: string; at: number; rows: Txn[] }[] = [];
  for (const t of txns) {
    const day = dayLabel(t.at);
    const last = groups[groups.length - 1];
    if (last && last.day === day) {
      last.rows.push(t);
    } else {
      groups.push({ day, at: t.at, rows: [t] });
    }
  }

  return (
    <div className="page">
      <div className="view-head">
        <h2>Ledger</h2>
        <p>
          The append-only double-entry record. Click a row to see its legs —
          each posting nets to zero, so money is moved, never created.
        </p>
      </div>

      <Form method="get" action="/ledger" className="ledger-search">
        {/* Never prefilled and no browser autofill/history: you paste an exact id or hash. */}
        <input
          type="search"
          name="q"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-label="Search the ledger by id or hash"
          placeholder="Find a txn id, account, chain hash, Merkle root, or signature…"
        />
        <button type="submit">Find</button>
      </Form>

      {query ? <SearchResult query={query} hit={hit} /> : null}

      <div className="card card-flush">
        {txns.length === 0 ? (
          <div className="empty">No postings yet.</div>
        ) : (
          <DataTable
            className="table-tight"
            columns={[
              { key: 'type', label: 'Type' },
              { key: 'detail', label: 'Detail' },
              { key: 'amount', label: 'Amount', num: true },
              {
                key: 'balanced',
                label: <span className="sr-only">Balanced</span>,
                className: 'right',
              },
            ]}
          >
            {groups.map((g) => (
              <Fragment key={g.day}>
                <tr className="row-group">
                  <td colSpan={4}>{dayHeading(g.at)}</td>
                </tr>
                {g.rows.map((t) => (
                  <RowGroup
                    key={t.id}
                    txn={t}
                    open={open === t.id}
                    href={toggleHref(t.id)}
                  />
                ))}
              </Fragment>
            ))}
          </DataTable>
        )}
        <Pager offset={offset} limit={limit} total={total} />
      </div>
    </div>
  );
}

function RowGroup({
  txn,
  open,
  href,
}: {
  txn: Txn;
  open: boolean;
  href: string;
}) {
  return (
    <>
      <tr>
        <td>
          <Link
            to={href}
            preventScrollReset
            className="row-toggle"
            aria-expanded={open}
          >
            <StatusPill tone={KIND_TONE[txn.kind] ?? 'neutral'}>
              {txn.label}
            </StatusPill>
          </Link>
        </td>
        <td>
          <div className="cell-main">{txn.listing}</div>
          <div className="cell-sub mono">
            {entityName(txn.buyer)} → {entityName(txn.seller)}
            {txn.paymentType === 'Credits' ? '' : ` · ${txn.paymentType}`}
          </div>
        </td>
        <td className="num">
          {txn.priceCurrency === 'USD' ? (
            <Usd value={txn.priceCredits} />
          ) : (
            <Credits value={txn.priceCredits} />
          )}
        </td>
        <td className="right">
          {txn.balancedTo === 0 ? (
            <span className="bal-ok">
              <span aria-hidden="true">✓</span>
              <span className="sr-only">balanced</span>
            </span>
          ) : (
            <span className="bal-bad">
              ≠ {txn.balancedTo}
              <span className="sr-only"> — does not balance</span>
            </span>
          )}
        </td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={4} className="leg-cell">
            <div className="legs">
              <div className="dim small mono leg-id">{txn.id}</div>
              {txn.note ? <p className="leg-note">{txn.note}</p> : null}
              {withLegKeys(txn.legs).map(({ leg, key }) => (
                <div className="leg-row" key={key}>
                  <span className="leg-side">
                    <StatusPill tone={leg.side === 'debit' ? 'red' : 'green'}>
                      {leg.side}
                    </StatusPill>
                    <span className="mono">{leg.label}</span>
                  </span>
                  <span className={leg.side === 'debit' ? 'debit' : 'credit'}>
                    <Amount num={leg.amount} suf={leg.currency} />
                  </span>
                </div>
              ))}
              <div className="leg-foot">
                <Link
                  to={`/ledger/txn/${txn.id}`}
                  viewTransition
                  className="link"
                >
                  Explore this posting →
                </Link>
                {txn.sagaId ? (
                  <Link to="/payouts" className="link">
                    View this payout on the board ↗
                  </Link>
                ) : null}
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <PageError error={error} />;
}
