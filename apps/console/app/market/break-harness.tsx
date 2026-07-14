/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * Try to break it: fire a burst of purchases at one engine. The idempotent ledger commits exactly
 * one and the balance moves once — the same guarantee the conformance race suite proves.
 */

import { Form, Link } from 'react-router';

import type { Flash } from '~/flash';
import type { RaceTally } from '~/race';
import { BackField, fmtAmount } from '~/ui';
import { OwnedFlash, UserSelect } from './parts';

// The burst verdict. Every attempt is accounted for; the burst is "clean" only when no gate the
// visitor armed interfered, so the demonstration is pure idempotency (order) or a pure funds gate
// (drain).
function RaceBanner({ tally }: { tally: RaceTally }) {
  const accounted =
    tally.committed + tally.duplicates + tally.insufficient + tally.other ===
    tally.attempts;
  const clean = accounted && tally.other === 0;
  const refused =
    tally.mode === 'order'
      ? `${tally.duplicates} refused DUPLICATE_ORDER`
      : `${tally.insufficient} refused INSUFFICIENT_FUNDS`;
  return (
    <div className={`notice ${clean ? 'ok' : 'warn'} race`}>
      <div className="race-verdict">
        {tally.mode === 'order'
          ? `${tally.attempts} purchases, one order id: `
          : `${tally.attempts} spends, one wallet: `}
        {tally.committed} committed, {refused}
        {tally.other > 0 ? `, ${tally.other} refused by an armed gate` : ''}.
      </div>
      <div className="race-moved">
        Balance moved <b>{fmtAmount(tally.movedCredits)} Cr</b>{' '}
        {tally.mode === 'order'
          ? '— the idempotent ledger committed at most once.'
          : '— the funds gate held; never below zero.'}
      </div>
    </div>
  );
}

export function BreakHarness({
  flash,
  users,
  back,
  busy,
  raceTally,
}: {
  flash: Flash | null;
  users: string[];
  back: string;
  busy: boolean;
  raceTally: RaceTally | null;
}) {
  return (
    <div className="card break-card" id="race">
      <div className="card-head">
        <h3>Try to break it</h3>
        <p className="card-sub">
          Fire a burst of purchases at one engine. The idempotent ledger commits
          exactly one and the balance moves once — the same guarantee the
          conformance race suite proves under true parallelism on the Postgres
          and MySQL engines.
        </p>
      </div>
      <OwnedFlash flash={flash} form="market-break" />
      {raceTally ? <RaceBanner tally={raceTally} /> : null}
      <Form method="post" action="/actions/market" className="break-form">
        <BackField to={back} />
        <input type="hidden" name="form" value="market-break" />
        <div className="row">
          <div className="field">
            <label htmlFor="break-buyer">Buyer</label>
            <UserSelect
              id="break-buyer"
              name="buyer"
              users={users}
              fallback="usr_alice"
            />
          </div>
          <div className="field">
            <label htmlFor="break-seller">Seller</label>
            <UserSelect
              id="break-seller"
              name="seller"
              users={users}
              fallback="usr_nova"
            />
          </div>
          <div className="field">
            <label htmlFor="break-credits">Credits each</label>
            <input
              id="break-credits"
              name="credits"
              type="number"
              min={0}
              defaultValue={200}
            />
          </div>
          <div className="field">
            <label htmlFor="break-count">Concurrent</label>
            <input
              id="break-count"
              name="count"
              type="number"
              min={2}
              max={12}
              defaultValue={6}
            />
          </div>
        </div>
        <div className="row break-buttons">
          <button type="submit" name="op" value="race" disabled={busy}>
            Double-spend one order
          </button>
          <button type="submit" name="op" value="drain" disabled={busy}>
            Drain the wallet
          </button>
        </div>
      </Form>
      <p className="card-sub">
        <Link to="/integrity" className="link">
          Prove the books still balance
        </Link>{' '}
        after the race.
      </p>
    </div>
  );
}
