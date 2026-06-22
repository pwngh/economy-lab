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

import { Fragment, useState } from 'react';
import { Link } from 'react-router';

import type { Route } from './+types/ledger';
import { getEconomy } from '~/economy.server';
import { Amount, Credits, DataTable, StatusPill, Usd, dayLabel } from '~/ui';

type Txn = Route.ComponentProps['loaderData']['txns'][number];

export async function loader(_: Route.LoaderArgs) {
  const eco = await getEconomy();
  return { txns: eco.ledger() };
}

function dayHeading(at: number) {
  const d = dayLabel(at);
  return d.charAt(0).toUpperCase() + d.slice(1);
}

// The tone each row's type tag carries: money coming in is blue, a marketplace sale green, the
// payout lifecycle amber→green→red by outcome. Background plumbing (a fee sweep) is left neutral
// so the eye lands on the economic events first.
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

// The ledger feed: every committed posting, newest first, grouped by day and expandable to its
// double-entry legs. The worker's settlements and sweeps are folded to one row per event (their USD
// cash leg lives in the expansion), so the feed reads as a list of events rather than raw postings.
export default function Ledger({ loaderData }: Route.ComponentProps) {
  const { txns } = loaderData;
  const [open, setOpen] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
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
              { key: 'balanced', label: '', className: 'right' },
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
                    open={open.has(t.id)}
                    onToggle={() => toggle(t.id)}
                  />
                ))}
              </Fragment>
            ))}
          </DataTable>
        )}
      </div>
    </div>
  );
}

function RowGroup({
  txn,
  open,
  onToggle,
}: {
  txn: Txn;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className="clickable" onClick={onToggle}>
        <td>
          <StatusPill tone={KIND_TONE[txn.kind] ?? 'neutral'}>
            {txn.label}
          </StatusPill>
        </td>
        <td>
          <div className="cell-main">{txn.listing}</div>
          <div className="cell-sub mono">
            {txn.buyer} → {txn.seller}
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
            <span className="bal-ok" title="Debits and credits balance to zero">
              ✓
            </span>
          ) : (
            <span className="bal-bad">≠ {txn.balancedTo}</span>
          )}
        </td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={4} className="leg-cell">
            <div className="legs">
              <div className="dim small mono leg-id">{txn.id}</div>
              {txn.note ? <p className="leg-note">{txn.note}</p> : null}
              {txn.legs.map((leg, i) => (
                <div className="leg-row" key={i}>
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
              {txn.sagaId ? (
                <div className="leg-foot">
                  <Link to="/payouts" className="link">
                    View this payout on the board ↗
                  </Link>
                </div>
              ) : null}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
