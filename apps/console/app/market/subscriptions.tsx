/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * Subscriptions: the active board and the open form. One active subscription per user, seller, and
 * sku; the worker bills each due period as time advances and lapses it once the wallet runs dry.
 */

import { Form } from 'react-router';

import type { Flash } from '~/flash';
import {
  BackField,
  DataTable,
  StatusPill,
  dayLabel,
  entityName,
  fmtAmount,
} from '~/ui';
import type { SubscriptionView } from '~/views';
import { FieldNote, OwnedFlash, UserSelect, fieldError } from './parts';

export function Subscriptions({
  flash,
  subscriptions,
  users,
  back,
  busy,
}: {
  flash: Flash | null;
  subscriptions: SubscriptionView[];
  users: string[];
  back: string;
  busy: boolean;
}) {
  return (
    <div className="card" id="subscriptions">
      <h3>Subscriptions</h3>
      <p className="card-sub">
        A subscription charges its first period at open; the worker&apos;s sweep
        bills each due period as time advances, and lapses it after repeated
        failures once the wallet runs dry. One active subscription per user,
        seller, and sku — a duplicate is refused.
      </p>
      <OwnedFlash flash={flash} form="market-subscribe" />
      {subscriptions.length > 0 ? (
        <DataTable
          columns={[
            { key: 'sku', label: 'Subscription' },
            { key: 'who', label: 'Subscriber → seller' },
            { key: 'price', label: 'Per period', num: true },
            { key: 'period', label: 'Period #', num: true },
            { key: 'due', label: 'Next due' },
            { key: 'state', label: 'State' },
            { key: 'cancel', label: 'Actions' },
          ]}
        >
          {subscriptions.map((s) => (
            <tr key={s.id}>
              <td>{s.sku}</td>
              <td>
                {entityName(s.userId)} → {entityName(s.sellerId)}
              </td>
              <td className="num mono">
                {fmtAmount(s.priceCredits)} Cr / {s.periodDays}d
              </td>
              <td className="num mono">{s.period}</td>
              <td className="mono">
                {s.state === 'ACTIVE' ? dayLabel(s.nextDueAt) : '—'}
              </td>
              <td>
                <StatusPill
                  tone={
                    s.state === 'ACTIVE'
                      ? 'green'
                      : s.state === 'LAPSED'
                        ? 'red'
                        : 'blue'
                  }
                  dot
                >
                  {s.state}
                </StatusPill>
              </td>
              <td>
                {s.state === 'ACTIVE' ? (
                  <Form method="post" action="/actions/subscribe">
                    <BackField to={back} />
                    <input type="hidden" name="op" value="cancel" />
                    <input type="hidden" name="id" value={s.id} />
                    <button type="submit" className="btn small" disabled={busy}>
                      Cancel
                    </button>
                  </Form>
                ) : null}
              </td>
            </tr>
          ))}
        </DataTable>
      ) : null}
      <Form method="post" action="/actions/subscribe" className="mt-3">
        <BackField to={back} />
        <input type="hidden" name="op" value="subscribe" />
        <div className="row">
          <div className="field">
            <label htmlFor="sub-user">Subscriber</label>
            <UserSelect
              id="sub-user"
              name="user"
              users={users}
              fallback="usr_alice"
            />
            <FieldNote
              id="sub-user-error"
              error={fieldError(flash, 'market-subscribe', 'user')}
            />
          </div>
          <div className="field">
            <label htmlFor="sub-seller">Seller</label>
            <UserSelect
              id="sub-seller"
              name="seller"
              users={users}
              fallback="usr_nova"
            />
            <FieldNote
              id="sub-seller-error"
              error={fieldError(flash, 'market-subscribe', 'seller')}
            />
          </div>
        </div>
        <div className="row">
          <div className="field">
            <label htmlFor="sub-sku">Subscription</label>
            <input id="sub-sku" name="sku" defaultValue="Aurora Fan Club" />
            <FieldNote
              id="sub-sku-error"
              error={fieldError(flash, 'market-subscribe', 'sku')}
            />
          </div>
          <div className="field">
            <label htmlFor="sub-credits">Credits / period</label>
            <input
              id="sub-credits"
              name="credits"
              type="number"
              min="1"
              defaultValue="100"
            />
            <FieldNote
              id="sub-credits-error"
              error={fieldError(flash, 'market-subscribe', 'credits')}
            />
          </div>
          <div className="field">
            <label htmlFor="sub-days">Period (days)</label>
            <input
              id="sub-days"
              name="days"
              type="number"
              min="1"
              defaultValue="7"
            />
            <FieldNote
              id="sub-days-error"
              error={fieldError(flash, 'market-subscribe', 'days')}
            />
          </div>
        </div>
        <button type="submit" disabled={busy}>
          Subscribe
        </button>
      </Form>
    </div>
  );
}
