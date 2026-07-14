/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * The payout saga board, and a per-card drill (?saga=pay_3): the saga's ledger postings and an
 * operator reversePayout form. A stuck card is reversed by a plain form post and the reserve returns to
 * the seller's earned balance on the same revalidation; a live SUBMITTED reversal renders the
 * engine's refusal.
 */

import { Form, Link, useLocation, useNavigation } from 'react-router';

import { PAGE_SIZE } from '~/economy';
import { getEngine } from '~/engine';
import type { Flash } from '~/flash';
import {
  Amount,
  Credits,
  DataTable,
  Entity,
  FlashBanner,
  IdChip,
  PageError,
  Pager,
  StatusPill,
  Usd,
  dayLabel,
  entityName,
  fmtAmount,
  pageMeta,
  pageOffset,
  useFlash,
} from '~/ui';
import type { Route } from './+types/payouts';

export function meta(args: Route.MetaArgs) {
  return pageMeta(
    args,
    'Payouts',
    'Cash-out sagas from reserve to settlement, with retries and operator reversal.',
  );
}

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const eco = await getEngine();
  const offset = pageOffset(request.url, PAGE_SIZE);
  const sagaId = new URL(request.url).searchParams.get('saga');
  const [page, counts, detail] = await Promise.all([
    eco.payouts({ offset, limit: PAGE_SIZE }),
    eco.payoutCounts(),
    sagaId ? eco.sagaDetail(sagaId) : Promise.resolve(null),
  ]);
  return {
    page,
    counts,
    settings: eco.settings(),
    detail,
  };
}

type PayoutView = Route.ComponentProps['loaderData']['page']['rows'][number];
type Detail = NonNullable<Route.ComponentProps['loaderData']['detail']>;

const STATE_TONE: Record<string, 'blue' | 'amber' | 'green' | 'red'> = {
  REQUESTED: 'blue',
  RESERVED: 'blue',
  SUBMITTED: 'amber',
  SETTLED: 'green',
  FAILED: 'red',
};

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
  const { page, counts, settings, detail } = loaderData;
  const flash = useFlash();
  const { rows: payouts, offset, limit, total } = page;
  const location = useLocation();
  const back = `${location.pathname}${location.search}`;
  const navigation = useNavigation();
  const busy = navigation.state !== 'idle';

  // Opening or closing a drill must not lose the board's page, and paging must not close the drill:
  // `boardQs` is the board state without `saga`, `pagerBase` the board state without `page`.
  const boardParams = new URLSearchParams(location.search);
  boardParams.delete('saga');
  const boardQs = boardParams.toString();
  const closeTo = boardQs ? `/payouts?${boardQs}` : '/payouts';
  const pagerBase = new URLSearchParams(location.search);
  pagerBase.delete('page');

  // The board is paged across all states, so a page may not fill every column; the true per-column
  // total comes from `counts`, not from this page's cards.
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
        <div className="row between">
          <div>
            <h2>Payouts</h2>
            <p>
              Each card is one payout, tracked from reserve to settlement. Open
              one to see its postings and — as the operator — reverse it.
            </p>
          </div>
          <Form method="post" action="/actions/simulate">
            <input type="hidden" name="back" value={back} />
            <input type="hidden" name="op" value="settle" />
            <button type="submit" disabled={busy}>
              Settle submitted
            </button>
          </Form>
        </div>
      </div>

      {settings.faultMode ? (
        <div className="notice warn">
          Tilia is down — every submit fails. Advance time, then run jobs: each
          failed run raises a payout&apos;s attempt count. Once it reaches the
          cap (set on Controls) the payout is abandoned — it moves to Failed and
          its reserved credits are returned to the seller.
        </div>
      ) : null}

      {detail ? (
        <SagaDrill
          detail={detail}
          flash={flash}
          back={back}
          busy={busy}
          closeTo={closeTo}
        />
      ) : null}

      <div className="kanban">
        {COLUMNS.map((col) => {
          const items = byState(col.state);
          const colTotal = countFor(col.state);
          return (
            <section
              className="kanban-col"
              data-state={col.state.toLowerCase()}
              key={col.state}
              aria-labelledby={`col-${col.state}`}
            >
              <div className="kanban-head">
                <h3 id={`col-${col.state}`}>
                  {col.title}{' '}
                  <span className="sr-only">— {colTotal} payouts</span>
                </h3>
                <StatusPill tone={col.tone}>{colTotal}</StatusPill>
              </div>
              {items.length === 0 ? (
                <div className="kanban-empty">
                  {colTotal === 0 ? 'No payouts' : 'None on this page'}
                </div>
              ) : (
                <ul className="kanban-list">
                  {items.map((p) => (
                    <li key={p.id}>
                      <Card
                        p={p}
                        cap={settings.maxPayoutAttempts}
                        board={boardQs}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>

      <Pager
        offset={offset}
        limit={limit}
        total={total}
        baseSearch={pagerBase}
      />

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

function Card({
  p,
  cap,
  board,
}: {
  p: PayoutView;
  cap: number;
  board: string;
}) {
  const terminal = p.state === 'SETTLED' || p.state === 'FAILED';
  const failed = p.state === 'FAILED';
  const openParams = new URLSearchParams(board);
  openParams.set('saga', p.id);
  return (
    <div className="kanban-card">
      <div className="kc-id">
        <IdChip id={p.id} />
      </div>
      <div className="kc-amt">
        <Credits value={p.reserveCredits} />
      </div>
      <Entity id={p.userId} />
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
      <Link
        to={`?${openParams}`}
        preventScrollReset
        viewTransition
        className="kc-open link"
      >
        Open →
      </Link>
    </div>
  );
}

function SagaDrill({
  detail,
  flash,
  back,
  busy,
  closeTo,
}: {
  detail: Detail;
  flash: Flash | null;
  back: string;
  busy: boolean;
  closeTo: string;
}) {
  const { saga, postings, reversible, truncated } = detail;
  return (
    <div className="card card-flush saga-drill">
      <div className="card-head">
        <div className="row between">
          <h3>
            Payout <span className="mono">{saga.id}</span>{' '}
            <StatusPill tone={STATE_TONE[saga.state] ?? 'neutral'}>
              {saga.state}
            </StatusPill>
          </h3>
          <Link to={closeTo} className="btn">
            Close
          </Link>
        </div>
        <p className="card-sub">
          <Entity id={saga.userId} /> · reserve{' '}
          <Credits value={saga.reserveCredits} /> · {saga.attempts} attempts
          {saga.payoutUsd !== null
            ? ` · paid $${fmtAmount(saga.payoutUsd)}`
            : ''}
        </p>
      </div>

      <div aria-live="polite" className="owned-flash drill-flash">
        {flash && flash.form === 'payout-reverse' ? (
          <FlashBanner flash={flash} />
        ) : null}
      </div>

      <div className="drill-section">
        <div className="sb-title">Postings</div>
        {postings.length === 0 ? (
          <div className="empty">
            Only the reserve so far — run jobs to move it forward.
          </div>
        ) : (
          <DataTable
            columns={[
              { key: 'txn', label: 'Posting' },
              { key: 'what', label: 'Detail' },
              { key: 'amount', label: 'Amount', num: true },
            ]}
          >
            {postings.map((t) => (
              <tr key={t.id}>
                <td>
                  <Link to={`/ledger/txn/${t.id}`} className="link mono">
                    {t.id}
                  </Link>
                </td>
                <td>{t.label}</td>
                <td className="num">
                  {t.priceCurrency === 'USD' ? (
                    <Usd value={t.priceCredits} />
                  ) : (
                    <Amount num={fmtAmount(t.priceCredits)} suf="Cr" />
                  )}
                </td>
              </tr>
            ))}
          </DataTable>
        )}
        {truncated ? (
          <div className="sb-note">
            Showing the first postings only — this account&apos;s ledger is
            large enough that the scan was bounded.
          </div>
        ) : null}
      </div>

      <div className="drill-section">
        <div className="sb-title">Operator reversal</div>
        {reversible ? (
          <Form method="post" action="/actions/reverse" className="row">
            <input type="hidden" name="back" value={back} />
            <input type="hidden" name="form" value="payout-reverse" />
            <input type="hidden" name="sagaId" value={saga.id} />
            <input type="hidden" name="userId" value={saga.userId} />
            <button type="submit" disabled={busy}>
              Reverse this payout
            </button>
            <span className="sb-note">
              Returns the reserve to {entityName(saga.userId)}&apos;s earned
              balance. A live submitted payout is refused until it ages past the
              provider settlement window.
            </span>
          </Form>
        ) : (
          <div className="sb-note">
            This payout is {saga.state.toLowerCase()} — a terminal state — so it
            cannot be reversed.
          </div>
        )}
      </div>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <PageError error={error} />;
}
