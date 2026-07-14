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

import { Suspense } from 'react';

import { Await, Form, useLocation, useNavigation } from 'react-router';

import { getEngine } from '~/engine';
import {
  Credits,
  DataTable,
  FlashBanner,
  PageError,
  StatCard,
  StatusPill,
  Usd,
  fmtAmount,
  pageMeta,
  useFlash,
} from '~/ui';
import type { Route } from './+types/integrity';

export function meta(args: Route.MetaArgs) {
  return pageMeta(
    args,
    'Integrity',
    'Five invariants re-derived from the raw ledger — then break the books and watch the audit catch it.',
  );
}

export async function clientLoader() {
  const eco = await getEngine();
  const [prove, solvency, checkpoint] = await Promise.all([
    eco.prove(),
    eco.solvency(),
    eco.checkpoint(),
  ]);
  // Deferred on purpose: the full prover re-derives every hash and balance, so the light report
  // paints first and the audit streams in under it.
  return { prove, solvency, checkpoint, full: eco.proveFull() };
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
    desc: 'Real USD in trust covers the credits users paid for, valued at the CREDIT-to-USD rate.',
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

// The integrity (prove) report: the five properties the ledger guarantees, read live — plus the
// theater: break the books on purpose and watch the prover catch it.
export default function Integrity({ loaderData }: Route.ComponentProps) {
  const { prove, solvency, checkpoint, full } = loaderData;
  const flash = useFlash();
  const location = useLocation();
  const back = `${location.pathname}${location.search}`;
  const busy = useNavigation().state !== 'idle';

  return (
    <div className="page">
      <div className="view-head">
        <h2>Integrity</h2>
        <p>
          Each flag is one property the books must always hold —{' '}
          <a className="link" href="/economy/concepts/the-proof/">
            how the proof works →
          </a>
        </p>
      </div>

      <div className="card card-row">
        <div>
          <h3>Quick checks</h3>
          <p className="card-sub m-0">
            {prove.allGreen
              ? 'The light pass holds. The full audit below re-derives everything from the raw ledger.'
              : 'One or more quick checks need attention.'}
          </p>
        </div>
        <StatusPill tone={prove.allGreen ? 'green' : 'red'} dot>
          {prove.allGreen ? 'All green' : 'Attention'}
        </StatusPill>
      </div>

      <Suspense
        fallback={
          <div className="card">
            <h3>Full audit</h3>
            <p className="card-sub m-0" aria-live="polite">
              Re-deriving every hash and balance from the raw ledger…
            </p>
          </div>
        }
      >
        <Await resolve={full}>
          {(audit) => (
            <>
              <div className="cards grid-2">
                {CHECKS.map((c) => {
                  const ok = audit[c.key];
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
                          Shortfall ${fmtAmount(audit.shortfallUsd)}.
                        </p>
                      ) : null}
                      {c.key === 'consistent' && !ok ? (
                        <p className="notice err mt-2">
                          {audit.drift.length} account(s) drifted.
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              {audit.drift.length > 0 ? (
                <div className="card card-flush">
                  <div className="card-head">
                    <h3>Drifted accounts</h3>
                    <p className="card-sub">
                      Each row is a cached balance that disagrees with the
                      balance re-added from the account&apos;s own debit and
                      credit lines. The lines are the source of truth.
                    </p>
                  </div>
                  <DataTable
                    columns={[
                      { key: 'account', label: 'Account' },
                      { key: 'cached', label: 'Cached', num: true },
                      { key: 'derived', label: 'Derived from legs', num: true },
                    ]}
                  >
                    {audit.drift.map((d) => (
                      <tr key={d.account}>
                        <td className="mono">{d.account}</td>
                        <td className="num mono">
                          {fmtAmount(d.cachedCredits)} Cr
                        </td>
                        <td className="num mono">
                          {fmtAmount(d.derivedCredits)} Cr
                        </td>
                      </tr>
                    ))}
                  </DataTable>
                </div>
              ) : null}
            </>
          )}
        </Await>
      </Suspense>

      <div className="card" id="break">
        <h3>Break the books</h3>
        <p className="card-sub">
          Your sandbox, your crime scene. Corrupt the ledger the two ways an
          operator fears — an edited posting, an unexplained balance — and the
          checks above catch each one on the next load. Heal rebuilds from the
          seed.
        </p>
        <div aria-live="polite" className="owned-flash">
          {flash && flash.form === 'integrity-break' ? (
            <FlashBanner flash={flash} />
          ) : null}
        </div>
        <div className="row">
          <Form method="post" action="/actions/tamper">
            <input type="hidden" name="back" value={back} />
            <input type="hidden" name="op" value="tamper" />
            <button type="submit" disabled={busy}>
              Tamper with a posting
            </button>
          </Form>
          <Form method="post" action="/actions/tamper">
            <input type="hidden" name="back" value={back} />
            <input type="hidden" name="op" value="drift" />
            <button type="submit" disabled={busy}>
              Plant a drifted balance
            </button>
          </Form>
          <Form method="post" action="/actions/tamper">
            <input type="hidden" name="back" value={back} />
            <input type="hidden" name="op" value="heal" />
            <button type="submit" className="primary" disabled={busy}>
              Heal the books
            </button>
          </Form>
        </div>
      </div>

      {checkpoint ? (
        <div className="card">
          <h3>Latest signed checkpoint</h3>
          <p className="card-sub">
            The worker&apos;s periodic seal: a Merkle root over every
            account&apos;s chain head, signed, covering {checkpoint.count}{' '}
            postings. Paste the root or signature into the Ledger search to
            resolve it.
          </p>
          <p className="mono small">root {checkpoint.root}</p>
          <p className="mono small">sig&nbsp; {checkpoint.signature}</p>
        </div>
      ) : null}

      <div className="card">
        <h3>Backing detail</h3>
        <p className="card-sub mt-2">
          Only custodial credits — the ones users bought with cash — must be
          backed by USD. Valued at par, they cannot exceed the trust cash held.
        </p>
        <div className="cards grid-4 mt-3">
          <StatCard
            label="Custodial credits"
            value={<Credits value={solvency.purchased} />}
          />
          <StatCard
            label="USD backing needed"
            value={<Usd value={solvency.backingUsd} />}
            sub="at par"
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

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <PageError error={error} />;
}
