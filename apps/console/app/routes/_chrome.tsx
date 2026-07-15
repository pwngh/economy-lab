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

// The frame every page sits in: sidebar nav, topbar clock and tickers, and the active page.
// Mutations are plain forms that redirect back and leave a one-shot flash (see flash.ts); the
// shared loader re-reads solvency and the proof on every navigation.

import { useEffect, useState } from 'react';

import {
  Form,
  Link,
  NavLink,
  Outlet,
  useLocation,
  useNavigation,
  useRevalidator,
  useRouteLoaderData,
} from 'react-router';

import type { ReactNode } from 'react';
import { DAY_MS } from '~/demo';
import { getEngine } from '~/engine';
import { takeFlash } from '~/flash';
import {
  BackField,
  FlashBanner,
  StatusPill,
  dayLabel,
  entityName,
  fmtAmount,
} from '~/ui';
import type { Route } from './+types/_chrome';

// The guided tour is URL state (?tour=n): a caption strip with plain links, nothing more, so it
// is keyboard-complete and survives reloads for free. Each step names the page it sits on.
const TOUR: { to: string; label: string; caption: string }[] = [
  {
    to: '/',
    label: 'Overview',
    caption:
      'The one number this ledger defends: every purchased credit backed by real USD in trust. Scenarios below stage whole stories in one click.',
  },
  {
    to: '/market',
    label: 'Market',
    caption:
      'Drive the economy — fund, buy, subscribe, cash out — then arm the gates and watch the same forms decline with reason codes.',
  },
  {
    to: '/ledger',
    label: 'Ledger',
    caption:
      'Every movement is a balanced double-entry posting. Open one to see its legs, or search any id, account, or hash.',
  },
  {
    to: '/payouts',
    label: 'Payouts',
    caption:
      'Cash-out sagas: reserve → submit → settle, with retries and reversals. Advance time in the topbar to move the cards.',
  },
  {
    to: '/pipeline',
    label: 'Pipeline',
    caption:
      'Events cross the edge exactly once: the outbox relays, the inbox dedupes a redelivered webhook.',
  },
  {
    to: '/integrity',
    label: 'Integrity',
    caption:
      'Five invariants re-derived live from the raw ledger — then break the books on purpose and watch the audit catch it.',
  },
  {
    to: '/controls',
    label: 'Controls',
    caption:
      'The operator surface: governed rates, the provider outage switch, and Reset when you want the seed back.',
  },
];

// Chrome data is time-and-proof: re-read on every navigation, not only after mutations, so the
// clock, the tickers, and the one-shot flash stay current.
export function shouldRevalidate() {
  return true;
}

export async function clientLoader() {
  const eco = await getEngine();
  const [solvency, prove] = await Promise.all([eco.solvency(), eco.prove()]);
  return {
    settings: eco.settings(),
    solvency,
    prove,
    flash: takeFlash(),
  };
}

const NAV = [
  { to: '/', label: 'Overview', end: true },
  { to: '/market', label: 'Market' },
  { to: '/accounts', label: 'Accounts' },
  { to: '/ledger', label: 'Ledger' },
  { to: '/payouts', label: 'Payouts' },
  { to: '/pipeline', label: 'Pipeline' },
  { to: '/integrity', label: 'Integrity' },
  { to: '/controls', label: 'Controls' },
  { to: '/developers', label: 'Developers' },
];

// The current URL, search params included, is what a mutation returns to.
function useBack(): string {
  const location = useLocation();
  return `${location.pathname}${location.search}`;
}

function actorLabel(actor: string | null): string {
  if (actor === null) {
    return 'the owner';
  }
  if (actor === 'operator') {
    return 'Operator';
  }
  if (actor === 'system') {
    return 'Platform';
  }
  return entityName(actor);
}

export default function Chrome({ loaderData }: Route.ComponentProps) {
  const { settings, solvency, flash } = loaderData;
  const back = useBack();
  const location = useLocation();
  const tourRaw = new URLSearchParams(location.search).get('tour');
  const tourStep = tourRaw === null ? null : Number.parseInt(tourRaw, 10);
  const tour =
    tourStep !== null && TOUR[tourStep] !== undefined ? tourStep : null;
  const root = useRouteLoaderData<{
    theme: string | null;
    actor: string | null;
  }>('root');
  const theme = root?.theme ?? null;
  const actor = root?.actor ?? null;

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
            prefetch="intent"
            viewTransition
            className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
          >
            {item.label}
          </NavLink>
        ))}

        <div className="nav-foot">
          <div className="acting-as">
            Acting as{' '}
            <Link to="/market" className="link">
              {actorLabel(actor)}
            </Link>
          </div>
          <div>
            <Link to="/?tour=0" className="link">
              Take the tour
            </Link>
          </div>
          <Form method="post" action="/actions/theme" className="theme-switch">
            <BackField to={back} />
            <span className="theme-switch-label">Theme</span>
            <button
              type="submit"
              name="theme"
              value="light"
              aria-pressed={theme === 'light'}
            >
              Light
            </button>
            <button
              type="submit"
              name="theme"
              value="dark"
              aria-pressed={theme === 'dark'}
            >
              Dark
            </button>
            <button
              type="submit"
              name="theme"
              value="auto"
              aria-pressed={theme === null}
            >
              Auto
            </button>
          </Form>
        </div>
      </aside>

      <main className="main">
        <Topbar
          now={loaderData.settings.now}
          prove={loaderData.prove}
          solvency={solvency}
          back={back}
        />
        {tour === null ? null : (
          <TourStrip step={tour} exitTo={location.pathname} />
        )}
        <div aria-live="polite">
          {flash && !flash.form ? <FlashBanner flash={flash} /> : null}
        </div>
        <Outlet />
      </main>
    </div>
  );
}

// One tour step: the caption for this page, and plain links onward — Next carries ?tour along,
// Exit drops it.
function TourStrip({ step, exitTo }: { step: number; exitTo: string }) {
  const current = TOUR[step];
  const next = TOUR[step + 1];
  return (
    <output className="tour">
      <span className="tour-count mono">
        {step + 1}/{TOUR.length}
      </span>
      <span className="tour-caption">{current.caption}</span>
      <span className="tour-actions">
        {next ? (
          <Link
            to={`${next.to}?tour=${step + 1}`}
            className="tour-next"
            viewTransition
          >
            Next: {next.label} →
          </Link>
        ) : null}
        <Link to={exitTo} className="tour-exit">
          {next ? 'Exit' : 'Done'}
        </Link>
      </span>
    </output>
  );
}

// The clock and the thesis, on every page: simulated time with its advance controls beside it,
// and the solvency ticker — the prove() verdict re-checked on every revalidation.
function Topbar({
  now,
  prove,
  solvency,
  back,
}: {
  now: number;
  prove: Route.ComponentProps['loaderData']['prove'];
  solvency: Route.ComponentProps['loaderData']['solvency'];
  back: string;
}) {
  const navigation = useNavigation();
  const busy =
    navigation.state !== 'idle' &&
    navigation.formAction === '/actions/simulate';

  // Live mode: a real interval ticks the clock forward and runs the worker, and the revalidator
  // re-reads every loader — the economy breathes on its own. Off by default so the deterministic
  // day-0 state stays put until asked; the facade's mutation queue serializes the ticks against
  // anything the user does meanwhile.
  const [live, setLive] = useState(false);
  // revalidate is stable; the revalidator object is not, and as a dep it would re-register the
  // interval on every revalidation.
  const { revalidate } = useRevalidator();
  useEffect(() => {
    if (!live) {
      return;
    }
    const tick = setInterval(() => {
      void (async () => {
        const eco = await getEngine();
        eco.advanceTime(DAY_MS / 4);
        await eco.runJobs();
        revalidate();
      })();
    }, 4000);
    return () => clearInterval(tick);
  }, [live, revalidate]);

  return (
    <div className="topbar">
      <div className="topbar-clock">
        {/* role="timer": a clock expected to change; its implicit aria-live=off keeps live-mode
            ticks from being announced every four seconds. */}
        <span
          className="topbar-day mono"
          role="timer"
          aria-label={`Simulated clock: ${dayLabel(now)}`}
        >
          {dayLabel(now)}
        </span>
        <SimButton op="advance" back={back} extra={{ days: '1' }} busy={busy}>
          +1 day
        </SimButton>
        <SimButton op="advance" back={back} extra={{ days: '7' }} busy={busy}>
          +7 days
        </SimButton>
        <SimButton op="runJobs" back={back} busy={busy}>
          Run jobs
        </SimButton>
        <button
          type="button"
          className={`live-toggle${live ? ' on' : ''}`}
          aria-pressed={live}
          aria-label="Live mode: advance the simulated clock automatically"
          onClick={() => setLive((v) => !v)}
        >
          <span className="live-dot" aria-hidden="true" /> Live
        </button>
      </div>
      <div className="topbar-status">
        <Link to="/" className="topbar-ticker">
          <StatusPill tone={solvency.backed ? 'green' : 'red'} dot>
            Backing {solvency.backed ? 'covered' : 'short'} · trust $
            {fmtAmount(solvency.trustCashUsd)}
          </StatusPill>
        </Link>
        <Link to="/integrity" className="topbar-ticker">
          <StatusPill tone={prove.allGreen ? 'green' : 'red'} dot>
            Σ debits = Σ credits ·{' '}
            {prove.allGreen ? 'proven on this load' : 'proof failing'}
          </StatusPill>
        </Link>
      </div>
    </div>
  );
}

// A one-button form posting a single sim op (plus any hidden fields). The topbar clock controls are this.
function SimButton({
  op,
  back,
  extra,
  busy,
  primary,
  children,
}: {
  op: string;
  back: string;
  extra?: Record<string, string>;
  busy: boolean;
  primary?: boolean;
  children: ReactNode;
}) {
  return (
    <Form method="post" action="/actions/simulate">
      <BackField to={back} />
      <input type="hidden" name="op" value={op} />
      {Object.entries(extra ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <button
        type="submit"
        className={primary ? 'primary' : undefined}
        disabled={busy}
      >
        {children}
      </button>
    </Form>
  );
}
