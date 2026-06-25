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

import { Link } from 'react-router';

import type { Route } from './+types/accounts';
import { getEconomy, PAGE_SIZE } from '~/economy.server';
import { Credits, DataTable, Pager, StatCard, pageOffset } from '~/ui';

// One bounded page of wallets, with an optional ?user= detail showing the per-account breakdown.
// The detail wallet is read directly (eco.wallet) rather than searched within the page, so a user
// who isn't on the current page still resolves.
export async function loader({ request }: Route.LoaderArgs) {
  const eco = await getEconomy();
  const offset = pageOffset(request.url, PAGE_SIZE);
  const selected = new URL(request.url).searchParams.get('user');
  const [page, detail] = await Promise.all([
    eco.wallets({ offset, limit: PAGE_SIZE }),
    selected ? eco.wallet(selected) : Promise.resolve(null),
  ]);
  return { page, detail, selected };
}

export default function Accounts({ loaderData }: Route.ComponentProps) {
  const { page, detail, selected } = loaderData;
  const { rows: wallets, offset, limit, total } = page;
  // Keep ?user= across page navigation so the open detail panel survives paging.
  const baseSearch = new URLSearchParams();
  if (selected) {
    baseSearch.set('user', selected);
  }

  return (
    <div className="page">
      <div className="view-head">
        <h2>Accounts</h2>
        <p>
          Every user holds three balances: purchased (USD-backed), earned
          (payout-eligible), and promotional (expiring grants).
        </p>
      </div>

      {detail ? (
        <div className="card page">
          <div className="row between">
            <h3 className="mono">{detail.userId}</h3>
            <Link to="/accounts" className="btn">
              Close
            </Link>
          </div>
          <div className="cards grid-4">
            <StatCard
              wallet="purchased"
              label="Purchased"
              value={<Credits value={detail.purchased} />}
              sub="spendable · USD-backed"
            />
            <StatCard
              wallet="earned"
              label="Earned"
              value={<Credits value={detail.earned} />}
              sub="seller revenue · payout-eligible"
            />
            <StatCard
              wallet="promo"
              label="Promotional"
              value={<Credits value={detail.promotional} />}
              sub="marketing grant · expires"
            />
            <StatCard
              wallet="total"
              label="Total"
              value={<Credits value={detail.total} />}
              sub="all balances"
            />
          </div>
        </div>
      ) : null}

      <div className="card card-flush">
        {wallets.length === 0 ? (
          <div className="empty">No users yet. Record a deposit to begin.</div>
        ) : (
          <DataTable
            columns={[
              { key: 'user', label: 'User' },
              { key: 'purchased', label: 'Purchased', num: true },
              { key: 'earned', label: 'Earned', num: true },
              { key: 'promotional', label: 'Promotional', num: true },
              { key: 'total', label: 'Total', num: true },
            ]}
          >
            {wallets.map((w) => (
              <tr key={w.userId} className="clickable">
                <td>
                  <Link to={`/accounts?user=${w.userId}`} className="mono">
                    {w.userId}
                  </Link>
                </td>
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
          </DataTable>
        )}
        <Pager
          offset={offset}
          limit={limit}
          total={total}
          baseSearch={baseSearch}
        />
      </div>
    </div>
  );
}
