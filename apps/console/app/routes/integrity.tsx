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

import type { Route } from './+types/integrity';
import { getEconomy } from '~/economy.server';
import { Credits, StatCard, StatusPill, Usd } from '~/ui';

export async function loader(_: Route.LoaderArgs) {
  const eco = await getEconomy();
  return { prove: await eco.prove(), solvency: await eco.solvency() };
}

const CHECKS: {
  key: 'conserved' | 'backed' | 'noOverdraft' | 'chainIntact' | 'consistent';
  title: string;
  desc: string;
}[] = [
  {
    key: 'conserved',
    title: 'Conserved',
    desc: 'Debits and credits cancel within each currency — no money created or lost.',
  },
  {
    key: 'backed',
    title: 'Backed',
    desc: 'Real USD in trust covers every credit the platform owes users.',
  },
  {
    key: 'noOverdraft',
    title: 'No overdraft',
    desc: 'No user account has gone below zero.',
  },
  {
    key: 'chainIntact',
    title: 'Chain intact',
    desc: 'Every account’s hash chain recomputes to its recorded value — nothing was tampered with.',
  },
  {
    key: 'consistent',
    title: 'Consistent',
    desc: 'No recorded balance has drifted from the balance re-derived from its legs.',
  },
];

// The integrity (prove) report: the five properties the ledger guarantees, read live.
export default function Integrity({ loaderData }: Route.ComponentProps) {
  const { prove, solvency } = loaderData;

  return (
    <div className="page">
      <div className="view-head">
        <h2>Integrity</h2>
        <p>Each flag is one property the books must always hold.</p>
      </div>

      <div className="card card-row">
        <div>
          <h3>Overall</h3>
          <p className="card-sub m-0">
            {prove.allGreen
              ? 'Every property holds.'
              : 'One or more properties need attention.'}
          </p>
        </div>
        <StatusPill tone={prove.allGreen ? 'green' : 'red'} dot>
          {prove.allGreen ? 'All green' : 'Attention'}
        </StatusPill>
      </div>

      <div className="cards grid-2">
        {CHECKS.map((c) => {
          const ok = prove[c.key];
          return (
            <div className="card" key={c.key}>
              <div className="row between">
                <h3>{c.title}</h3>
                <StatusPill tone={ok ? 'green' : 'red'} dot>
                  {ok ? 'OK' : 'FAIL'}
                </StatusPill>
              </div>
              <p className="card-sub mt-2">{c.desc}</p>
              {c.key === 'backed' && !ok ? (
                <p className="notice err mt-2">
                  Shortfall ${prove.shortfallUsd.toFixed(2)}.
                </p>
              ) : null}
              {c.key === 'consistent' && !ok ? (
                <p className="notice err mt-2">
                  {prove.driftCount} account(s) drifted.
                </p>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="card">
        <h3>Backing detail</h3>
        <div className="cards grid-3 mt-3">
          <StatCard
            label="Credits owed"
            value={<Credits value={solvency.userCredits} />}
          />
          <StatCard
            label="Trust cash"
            value={<Usd value={solvency.trustCashUsd} />}
          />
          <StatCard
            label="Shortfall"
            value={<Usd value={solvency.shortfallUsd} />}
          />
        </div>
      </div>
    </div>
  );
}
