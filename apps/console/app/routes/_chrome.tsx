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

// The frame every page sits in: sidebar nav, the active page, and a collapsible Simulation panel.
// The panel lives in the frame, not a page, so its controls are reachable everywhere.

import { NavLink, Outlet, useFetcher } from 'react-router';

import { useState, type ReactNode } from 'react';
import type { Route } from './+types/_chrome';
import { getEconomy } from '~/economy.server';
import { StatusPill, dayLabel, fmtAmount } from '~/ui';

// What the frame needs on every page: the sim settings (for the panel's controls) and the headline
// solvency figure. Both reads.
export async function loader(_: Route.LoaderArgs) {
  const eco = await getEconomy();
  return { settings: eco.settings(), solvency: await eco.solvency() };
}

const NAV = [
  { to: '/', label: 'Overview', end: true },
  { to: '/accounts', label: 'Accounts' },
  { to: '/ledger', label: 'Ledger' },
  { to: '/payouts', label: 'Payouts' },
  { to: '/integrity', label: 'Integrity' },
  { to: '/developers', label: 'Developers' },
];

export default function Chrome({ loaderData }: Route.ComponentProps) {
  const { settings, solvency } = loaderData;
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-title">Economy Console</div>
          <div className="brand-sub">Double-entry credits ledger</div>
        </div>

        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
          >
            {item.label}
          </NavLink>
        ))}

        <div className="nav-foot">Clock · {dayLabel(settings.now)}</div>
      </aside>

      <main className="main">
        <Outlet />
        <SimulationPanel settings={settings} solvency={solvency} />
      </main>
    </div>
  );
}

// The control panel that drives the shared state. Each control posts to /actions/simulate via a
// fetcher; on return, React Router revalidates the active page's loader. The one-line result comes
// back in fx.data as a notice.
function SimulationPanel({
  settings,
  solvency,
}: {
  settings: Route.ComponentProps['loaderData']['settings'];
  solvency: Route.ComponentProps['loaderData']['solvency'];
}) {
  const fx = useFetcher<{ note?: string; error?: string }>();
  const busy = fx.state !== 'idle';
  const [open, setOpen] = useState(false);

  return (
    <section className="sim">
      <button
        className="sim-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="sim-toggle-label">
          <span className="sim-chevron" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          Simulation
        </span>
        <StatusPill tone={solvency.backed ? 'green' : 'red'} dot>
          Backing {solvency.backed ? 'covered' : 'short'} · trust $
          {fmtAmount(solvency.trustCashUsd)}
        </StatusPill>
      </button>

      {open ? (
        <div className="sim-body">
          {fx.data?.note ? (
            <div className="notice ok">{fx.data.note}</div>
          ) : null}
          {fx.data?.error ? (
            <div className="notice err">{fx.data.error}</div>
          ) : null}

          <div className="sim-grid">
            <div className="sim-block">
              <div className="sb-title">Time &amp; jobs</div>
              <div className="row">
                <SimButton
                  fx={fx}
                  op="advance"
                  extra={{ days: '1' }}
                  busy={busy}
                >
                  Advance 1 day
                </SimButton>
                <SimButton
                  fx={fx}
                  op="advance"
                  extra={{ days: '7' }}
                  busy={busy}
                >
                  +7 days
                </SimButton>
                <SimButton fx={fx} op="runJobs" busy={busy} primary>
                  Run jobs
                </SimButton>
              </div>
              <div className="sb-note">
                Advance the clock, then run jobs to move payouts forward.
              </div>
            </div>

            <div className="sim-block">
              <div className="sb-title">Payout provider (Tilia)</div>
              <fx.Form method="post" action="/actions/simulate">
                <input
                  type="hidden"
                  name="op"
                  value={settings.faultMode ? 'faultOff' : 'faultOn'}
                />
                <label className="toggle">
                  <StatusPill tone={settings.faultMode ? 'red' : 'green'} dot>
                    {settings.faultMode ? 'down' : 'up'}
                  </StatusPill>
                  <button disabled={busy}>
                    {settings.faultMode
                      ? 'Bring Tilia back up'
                      : 'Take Tilia down'}
                  </button>
                </label>
              </fx.Form>
              <div className="sb-note">
                While down, every payout submit fails.
              </div>
            </div>

            <div className="sim-block">
              <div className="sb-title">Maturity hold (days)</div>
              <fx.Form method="post" action="/actions/simulate" className="row">
                <input type="hidden" name="op" value="setMaturity" />
                <input
                  type="number"
                  name="days"
                  min={0}
                  defaultValue={settings.maturityHorizonDays}
                />
                <button disabled={busy}>Set</button>
              </fx.Form>
              <div className="sb-note">
                How long earned credits must mature before they can be paid out.
              </div>
            </div>

            <div className="sim-block">
              <div className="sb-title">Payout retry limit</div>
              <fx.Form method="post" action="/actions/simulate" className="row">
                <input type="hidden" name="op" value="setMaxAttempts" />
                <input
                  type="number"
                  name="n"
                  min={1}
                  defaultValue={settings.maxPayoutAttempts}
                />
                <button disabled={busy}>Set</button>
              </fx.Form>
              <div className="sb-note">
                Failed attempts before a payout is abandoned and its reserve
                returned.
              </div>
            </div>

            <div className="sim-block">
              <div className="sb-title">Sample data</div>
              <div className="row">
                <SimButton fx={fx} op="reset" busy={busy}>
                  Reset
                </SimButton>
                <SimButton fx={fx} op="clear" busy={busy}>
                  Clear
                </SimButton>
              </div>
              <div className="sb-note">
                Reset restores the sample data. Clear empties everything.
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

// A one-button form posting a single sim op (plus any hidden fields). Most panel controls are this.
function SimButton({
  fx,
  op,
  extra,
  busy,
  primary,
  children,
}: {
  fx: ReturnType<typeof useFetcher>;
  op: string;
  extra?: Record<string, string>;
  busy: boolean;
  primary?: boolean;
  children: ReactNode;
}) {
  return (
    <fx.Form method="post" action="/actions/simulate">
      <input type="hidden" name="op" value={op} />
      {Object.entries(extra ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <button className={primary ? 'primary' : undefined} disabled={busy}>
        {children}
      </button>
    </fx.Form>
  );
}
