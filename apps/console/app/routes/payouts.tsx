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

import type { Route } from './+types/payouts';
import { getEconomy, PAGE_SIZE } from '~/economy.server';
import { Credits, Pager, StatusPill, dayLabel, fmtAmount, pageOffset } from '~/ui';

export function meta(_: Route.MetaArgs) {
  return [{ title: 'Payouts — Economy Console' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const eco = await getEconomy();
  const offset = pageOffset(request.url, PAGE_SIZE);
  const [page, counts] = await Promise.all([
    eco.payouts({ offset, limit: PAGE_SIZE }),
    eco.payoutCounts(),
  ]);
  return { page, counts, settings: eco.settings() };
}

type PayoutView = Route.ComponentProps['loaderData']['page']['rows'][number];

// The saga lifecycle columns: RESERVED → SUBMITTED → SETTLED, plus FAILED (dead-letter, reserve
// reversed to the seller). REQUESTED folds into RESERVED, since requestPayout opens directly in it.
const COLUMNS: {
  state: PayoutView['state'];
  title: string;
  tone: 'blue' | 'amber' | 'green' | 'red';
}[] = [
  { state: 'RESERVED', title: 'Reserved', tone: 'blue' },
  { state: 'SUBMITTED', title: 'Submitted', tone: 'amber' },
  { state: 'SETTLED', title: 'Settled', tone: 'green' },
  { state: 'FAILED', title: 'Failed', tone: 'red' },
];

export default function Payouts({ loaderData }: Route.ComponentProps) {
  const { page, counts, settings } = loaderData;
  const { rows: payouts, offset, limit, total } = page;

  // The cards on this page, bucketed by column. The board is paged newest-first across all states,
  // so a given page may not fill every column — the *true* per-column total comes from `counts`
  // (a single streaming tally), shown in the header, while only this page's cards are rendered.
  const byState = (s: PayoutView['state']) =>
    payouts.filter((p) =>
      s === 'RESERVED'
        ? p.state === 'RESERVED' || p.state === 'REQUESTED'
        : p.state === s,
    );
  const countFor = (s: PayoutView['state']): number =>
    s === 'RESERVED'
      ? counts.RESERVED
      : s === 'SUBMITTED'
        ? counts.SUBMITTED
        : s === 'SETTLED'
          ? counts.SETTLED
          : counts.FAILED;

  return (
    <div className="page">
      <div className="view-head">
        <h2>Payouts</h2>
        <p>Each card is one payout, tracked from reserve to settlement.</p>
      </div>

      {settings.faultMode ? (
        <div className="notice warn">
          Tilia is down — every submit fails. Advance time, then run jobs: each
          failed run raises a payout&apos;s attempt count. Once it reaches the
          cap (set in Simulation) the payout is abandoned — it moves to Failed
          and its reserved credits are returned to the seller.
        </div>
      ) : null}

      <div className="kanban">
        {COLUMNS.map((col) => {
          const items = byState(col.state);
          const colTotal = countFor(col.state);
          return (
            <div
              className="kanban-col"
              data-state={col.state.toLowerCase()}
              key={col.state}
            >
              <div className="kanban-head">
                <span>{col.title}</span>
                <StatusPill tone={col.tone}>{colTotal}</StatusPill>
              </div>
              {items.length === 0 ? (
                <div className="kanban-empty">
                  {colTotal === 0 ? 'No payouts' : 'None on this page'}
                </div>
              ) : (
                items.map((p) => (
                  <Card key={p.id} p={p} cap={settings.maxPayoutAttempts} />
                ))
              )}
            </div>
          );
        })}
      </div>

      <Pager offset={offset} limit={limit} total={total} />

      <div className="card">
        <h3>How a card moves</h3>
        <p className="card-sub">
          A payout reserves the seller&apos;s earned credits (RESERVED), Tilia
          is paid (SUBMITTED, then SETTLED). If Tilia keeps failing, the payout
          is abandoned (FAILED) and its reserved credits are returned to the
          seller.
        </p>
      </div>
    </div>
  );
}

function Card({ p, cap }: { p: PayoutView; cap: number }) {
  const terminal = p.state === 'SETTLED' || p.state === 'FAILED';
  const failed = p.state === 'FAILED';
  return (
    <div className="kanban-card">
      <div className="kc-id" title={p.id}>
        {p.id}
      </div>
      <div className="kc-amt">
        <Credits value={p.reserveCredits} />
      </div>
      <div className="dim small mono">{p.userId}</div>
      <div className="kc-meta">
        <span>
          attempts <b className={p.attempts > 0 ? 'debit' : ''}>{p.attempts}</b>
          <span className="dim"> / {cap}</span>
        </span>
        {p.state === 'SETTLED' && p.payoutUsd !== null ? (
          <span>
            paid <b>${fmtAmount(p.payoutUsd)}</b>
          </span>
        ) : null}
        {failed ? <span>reserve returned to seller</span> : null}
        {failed && p.reason ? (
          <span className="debit">reason · {p.reason}</span>
        ) : null}
        {!terminal ? <span>due {dayLabel(p.dueAt)}</span> : null}
        <span className="mono" title={p.providerRef ?? undefined}>
          {p.providerRef ? `ref ${p.providerRef}` : 'no provider ref yet'}
        </span>
      </div>
    </div>
  );
}
