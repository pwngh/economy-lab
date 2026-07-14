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

import { Form, Link, useNavigation } from 'react-router';

import { getEngine } from '~/engine';
import {
  Credits,
  DataTable,
  Entity,
  PageError,
  StatusPill,
  Usd,
  pageMeta,
} from '~/ui';
import type { Route } from './+types/overview';

// One-click stories: each stages real state through the same facade the forms use and lands on
// the page where its consequence is visible.
const SCENARIOS: { op: string; label: string; sub: string }[] = [
  {
    op: 'race',
    label: 'Duplicate storm',
    sub: 'Eight purchases, one order id — one commits.',
  },
  {
    op: 'outage',
    label: 'Provider outage',
    sub: 'Tilia goes down mid-payout; retries climb.',
  },
  {
    op: 'immature',
    label: 'Immature earnings',
    sub: 'Fresh earnings hit the maturity horizon.',
  },
  {
    op: 'maintenance',
    label: 'Maintenance window',
    sub: 'User writes pause as ECONOMY_PAUSED.',
  },
  {
    op: 'tamper',
    label: 'Tampered ledger',
    sub: 'An edited posting fails the full audit.',
  },
];

// A short, bounded preview of wallets — the full, paged list lives on the Accounts page.
const PREVIEW = 8;

export function meta(_: Route.MetaArgs) {
  return pageMeta(
    'Overview',
    'A double-entry credits ledger proving itself live: every purchased credit backed by real USD in trust.',
  );
}

export async function clientLoader() {
  const eco = await getEngine();
  const [walletPage, accounts, solvency] = await Promise.all([
    eco.wallets({ offset: 0, limit: PREVIEW }),
    eco.platformAccounts(),
    eco.solvency(),
  ]);
  return { walletPage, accounts, solvency };
}

export default function Overview({ loaderData }: Route.ComponentProps) {
  const { walletPage, accounts, solvency } = loaderData;
  const wallets = walletPage.rows;
  const busy = useNavigation().state !== 'idle';
  // What the platform owes users in total, split by kind — the ledger-wide aggregate, independent
  // of how many wallets the preview shows.
  const owed = {
    purchased: solvency.purchased,
    earned: solvency.earned,
    promotional: solvency.promotional,
    total: solvency.userCredits,
  };

  return (
    <div className="page">
      <div className="view-head">
        <h2>Overview</h2>
        <p>
          The one number this ledger exists to defend: every credit users paid
          for is backed by real USD in trust.
        </p>
      </div>

      <div className="card card-row">
        <div className="backing-figures">
          <div>
            <div className="stat-label">Owed to users</div>
            <div className="stat-value">
              <Credits value={solvency.userCredits} />
            </div>
            <div className="stat-sub">purchased + earned + promotional</div>
          </div>
          <div className="backing-arrow" aria-hidden="true">
            →
          </div>
          <div>
            <div className="stat-label">Needs USD backing</div>
            <div className="stat-value">
              <Usd value={solvency.backingUsd} />
            </div>
            <div className="stat-sub">purchased credits, at par</div>
          </div>
          <div>
            <div className="stat-label">Trust cash</div>
            <div className="stat-value">
              <Usd value={solvency.trustCashUsd} />
            </div>
            <div className="stat-sub">real USD in reserve</div>
          </div>
        </div>
        <StatusPill tone={solvency.backed ? 'green' : 'red'} dot>
          {solvency.backed
            ? 'Fully backed'
            : `Short $${solvency.shortfallUsd.toFixed(2)}`}
        </StatusPill>
      </div>

      <div className="card">
        <h3>Scenarios</h3>
        <p className="card-sub">
          Stage a whole story in one click — real operations through the same
          gates the forms use. Each lands where its consequence is visible;
          Controls → Reset undoes everything.
        </p>
        <div className="scenario-grid">
          {SCENARIOS.map((s) => (
            <Form key={s.op} method="post" action="/actions/scenario">
              <input type="hidden" name="op" value={s.op} />
              <button
                type="submit"
                className="scenario-btn"
                disabled={busy}
                title={s.sub}
              >
                <span className="scenario-label">{s.label}</span>
                <span className="scenario-sub">{s.sub}</span>
              </button>
            </Form>
          ))}
        </div>
      </div>

      <div className="card card-flush">
        <div className="card-head">
          <h3>User wallets</h3>
          <p className="card-sub">
            {walletPage.total > wallets.length ? (
              <>
                A preview of {wallets.length} of {walletPage.total} wallets —
                see the full list on{' '}
                <Link to="/accounts" className="link">
                  Accounts
                </Link>
                .
              </>
            ) : (
              <>What each user holds, and the total the platform owes them.</>
            )}
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
                <td>
                  <Entity id={w.userId} />
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
            <tr className="row-total">
              <td>All users ({walletPage.total})</td>
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

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <PageError error={error} />;
}
