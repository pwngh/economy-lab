/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * The three economy-driving operations: buy a listing, request a payout, fund a wallet. Each is a
 * plain form; a rejection rides back as its owned flash, its reason code verbatim.
 */

import { Form } from 'react-router';

import type { Flash } from '~/flash';
import { BackField } from '~/ui';
import { FieldNote, OwnedFlash, UserSelect, fieldError } from './parts';

interface OpProps {
  flash: Flash | null;
  users: string[];
  actor: string | null;
  back: string;
  busy: boolean;
}

export function BuyForm({ flash, users, actor, back, busy }: OpProps) {
  return (
    <div className="card">
      <h3>Buy a listing</h3>
      <p className="card-sub">
        A spend splits the buyer&apos;s credits to the seller&apos;s earned
        balance. Reuse an order id to trip <code>DUPLICATE_ORDER</code>, or name
        a recipient to gift the entitlement.
      </p>
      <OwnedFlash flash={flash} form="market-purchase" />
      <Form method="post" action="/actions/purchase">
        <BackField to={back} />
        <input type="hidden" name="form" value="market-purchase" />
        {actor ? <input type="hidden" name="actor" value={actor} /> : null}
        <div className="row">
          <div className="field">
            <label htmlFor="buy-user">Buyer</label>
            <UserSelect
              id="buy-user"
              name="user"
              users={users}
              fallback="usr_alice"
            />
            <FieldNote
              id="buy-user-error"
              error={fieldError(flash, 'market-purchase', 'user')}
            />
          </div>
          <div className="field">
            <label htmlFor="buy-seller">Seller</label>
            <UserSelect
              id="buy-seller"
              name="seller"
              users={users}
              fallback="usr_nova"
            />
            <FieldNote
              id="buy-seller-error"
              error={fieldError(flash, 'market-purchase', 'seller')}
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor="buy-listing">Listing</label>
          <input id="buy-listing" name="listing" defaultValue="Aurora Avatar" />
        </div>
        <div className="row">
          <div className="field">
            <label htmlFor="buy-credits">Credits</label>
            <input
              id="buy-credits"
              name="credits"
              type="number"
              min={0}
              defaultValue={500}
              aria-describedby={
                fieldError(flash, 'market-purchase', 'credits')
                  ? 'buy-credits-error'
                  : undefined
              }
            />
            <FieldNote
              id="buy-credits-error"
              error={fieldError(flash, 'market-purchase', 'credits')}
            />
          </div>
          <div className="field">
            <label htmlFor="buy-order">Order id (optional)</label>
            <input
              id="buy-order"
              name="orderId"
              placeholder="reuse to duplicate"
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor="buy-gift">Gift the entitlement to (optional)</label>
          <UserSelect
            id="buy-gift"
            name="giftTo"
            users={users}
            fallback=""
            allowNone
          />
        </div>
        <button type="submit" className="primary full" disabled={busy}>
          {busy ? 'Submitting…' : 'Buy'}
        </button>
      </Form>
    </div>
  );
}

export function PayoutForm({ flash, users, actor, back, busy }: OpProps) {
  return (
    <div className="card">
      <h3>Request a payout</h3>
      <p className="card-sub">
        A seller cashes out earned credits. Below the minimum, too soon after
        the last request, still maturing, or short of balance — each declines
        with its own reason.
      </p>
      <OwnedFlash flash={flash} form="market-payout" />
      <Form method="post" action="/actions/payout">
        <BackField to={back} />
        <input type="hidden" name="form" value="market-payout" />
        {actor ? <input type="hidden" name="actor" value={actor} /> : null}
        <div className="field">
          <label htmlFor="pay-user">Seller</label>
          <UserSelect
            id="pay-user"
            name="user"
            users={users}
            fallback="usr_nova"
          />
          <FieldNote
            id="pay-user-error"
            error={fieldError(flash, 'market-payout', 'user')}
          />
        </div>
        <div className="field">
          <label htmlFor="pay-credits">Credits</label>
          <input
            id="pay-credits"
            name="credits"
            type="number"
            min={0}
            defaultValue={100}
            aria-describedby={
              fieldError(flash, 'market-payout', 'credits')
                ? 'pay-credits-error'
                : undefined
            }
          />
          <FieldNote
            id="pay-credits-error"
            error={fieldError(flash, 'market-payout', 'credits')}
          />
        </div>
        <button type="submit" className="primary full" disabled={busy}>
          {busy ? 'Submitting…' : 'Request payout'}
        </button>
      </Form>
    </div>
  );
}

export function FundForm({ flash, users, back, busy }: Omit<OpProps, 'actor'>) {
  return (
    <Form method="post" action="/actions/fund" className="card fund-card">
      <BackField to={back} />
      <input type="hidden" name="form" value="market-fund" />
      <h3>Fund a wallet</h3>
      <p className="card-sub">
        Top up purchased credits or grant promotional credits — what a wallet
        needs before it can spend.
      </p>
      <OwnedFlash flash={flash} form="market-fund" />
      <div className="fund-row">
        <div className="field">
          <label htmlFor="fund-type">Operation</label>
          <select id="fund-type" name="type" defaultValue="deposit">
            <option value="deposit">Deposit (buy credits)</option>
            <option value="promo">Grant promo</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="fund-user">User</label>
          <UserSelect
            id="fund-user"
            name="user"
            users={users}
            fallback="usr_alice"
          />
          <FieldNote
            id="fund-user-error"
            error={fieldError(flash, 'market-fund', 'user')}
          />
        </div>
        <div className="field">
          <label htmlFor="fund-credits">Credits</label>
          <input
            id="fund-credits"
            name="credits"
            type="number"
            min={0}
            defaultValue={1000}
            aria-describedby={
              fieldError(flash, 'market-fund', 'credits')
                ? 'fund-credits-error'
                : undefined
            }
          />
          <FieldNote
            id="fund-credits-error"
            error={fieldError(flash, 'market-fund', 'credits')}
          />
        </div>
        <button type="submit" disabled={busy}>
          Fund
        </button>
      </div>
    </Form>
  );
}
