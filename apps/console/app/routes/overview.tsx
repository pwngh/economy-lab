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

import { useFetcher } from 'react-router';

import type { Route } from './+types/overview';
import { getEconomy } from '~/economy.server';
import { Credits, DataTable, Usd } from '~/ui';

export async function loader(_: Route.LoaderArgs) {
  const eco = await getEconomy();
  const [wallets, accounts] = await Promise.all([
    eco.wallets(),
    eco.platformAccounts(),
  ]);
  return { wallets, accounts };
}

export default function Overview({ loaderData }: Route.ComponentProps) {
  const { wallets, accounts } = loaderData;
  // The bottom line of the wallets table: what the platform owes users in total, split by kind.
  const owed = wallets.reduce(
    (t, w) => ({
      purchased: t.purchased + w.purchased,
      earned: t.earned + w.earned,
      promotional: t.promotional + w.promotional,
      total: t.total + w.total,
    }),
    { purchased: 0, earned: 0, promotional: 0, total: 0 },
  );

  return (
    <div className="page">
      <div className="view-head">
        <h2>Overview</h2>
        <p>Balances and figures, derived from the double-entry ledger.</p>
      </div>

      <div className="cards split-table items-start">
        <div className="card card-flush">
          <div className="card-head">
            <h3>User wallets</h3>
            <p className="card-sub">
              What each user holds, and the total the platform owes them.
            </p>
          </div>
          {wallets.length === 0 ? (
            <div className="empty">No users yet.</div>
          ) : (
            <DataTable
              columns={[
                { key: 'user', label: 'User' },
                { key: 'purchased', label: 'Purchased', num: true },
                { key: 'earned', label: 'Earned', num: true },
                { key: 'promo', label: 'Promo', num: true },
                { key: 'total', label: 'Total', num: true },
              ]}
            >
              {wallets.map((w) => (
                <tr key={w.userId}>
                  <td className="mono">{w.userId}</td>
                  <td className="num">
                    <Credits value={w.purchased} />
                  </td>
                  <td className="num">
                    <Credits value={w.earned} />
                  </td>
                  <td className="num">
                    <Credits value={w.promotional} />
                  </td>
                  <td className="num">
                    <b>
                      <Credits value={w.total} />
                    </b>
                  </td>
                </tr>
              ))}
              <tr className="row-total">
                <td>All users ({wallets.length})</td>
                <td className="num">
                  <Credits value={owed.purchased} />
                </td>
                <td className="num">
                  <Credits value={owed.earned} />
                </td>
                <td className="num">
                  <Credits value={owed.promotional} />
                </td>
                <td className="num">
                  <b>
                    <Credits value={owed.total} />
                  </b>
                </td>
              </tr>
            </DataTable>
          )}
        </div>

        <RecordCard />
      </div>

      <div className="card card-flush">
        <div className="card-head">
          <h3>Platform accounts</h3>
          <p className="card-sub">
            The platform&apos;s own ledger accounts — the house side of the
            books, behind every user balance.
          </p>
        </div>
        <DataTable
          columns={[
            { key: 'account', label: 'Account' },
            { key: 'balance', label: 'Balance', num: true },
          ]}
        >
          {accounts.map((a) => (
            <tr key={a.key}>
              <td>
                <div className="cell-main">{a.label}</div>
                <div className="cell-sub">{a.sublabel}</div>
              </td>
              <td className="num">
                {a.currency === 'USD' ? (
                  <Usd value={a.value} />
                ) : (
                  <Credits value={a.value} />
                )}
              </td>
            </tr>
          ))}
        </DataTable>
      </div>
    </div>
  );
}

// The record form — submits one operation to /actions/record via a fetcher, with inline
// success/decline notices. The buyer/seller/listing fields only apply to a purchase.
function RecordCard() {
  const fx = useFetcher<{ note?: string; error?: string; ok?: boolean }>();
  const busy = fx.state !== 'idle';

  return (
    <div className="card">
      <h3>Record an operation</h3>
      <p className="card-sub">Declines (such as immature funds) show inline.</p>

      {fx.data?.error ? (
        <div className="notice err">{fx.data.error}</div>
      ) : null}
      {fx.data?.ok ? <div className="notice ok">{fx.data.note}</div> : null}

      <fx.Form
        method="post"
        action="/actions/record"
        key={fx.data?.ok ? Math.random() : 'form'}
      >
        <div className="field">
          <label>Type</label>
          <select name="type" defaultValue="deposit">
            <option value="deposit">Deposit (buy credits)</option>
            <option value="purchase">Purchase (spend on a listing)</option>
            <option value="payout">Request payout</option>
            <option value="promo">Grant promo</option>
          </select>
        </div>
        <div className="field">
          <label>User id</label>
          <input name="user" placeholder="usr_alice" defaultValue="usr_alice" />
        </div>
        <div className="row">
          <div className="field">
            <label>Seller (purchase only)</label>
            <input name="seller" placeholder="usr_nova" />
          </div>
          <div className="field">
            <label>Listing (purchase only)</label>
            <input name="listing" placeholder="Aurora Avatar" />
          </div>
        </div>
        <div className="field">
          <label>Credits</label>
          <input name="credits" type="number" min={0} defaultValue={1000} />
        </div>
        <button className="primary full" disabled={busy}>
          {busy ? 'Submitting…' : 'Record'}
        </button>
      </fx.Form>
    </div>
  );
}
