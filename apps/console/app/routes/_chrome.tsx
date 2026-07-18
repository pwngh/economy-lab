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
import { advanceHint, hintOn } from '~/hints';
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
      'Every purchased credit is backed by real USD in trust. Scenarios stage whole stories in one click.',
  },
  {
    to: '/market',
    label: 'Market',
    caption:
      'Fund, buy, subscribe, cash out — then arm the gates and the same forms decline with reason codes.',
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
      'Five invariants re-derived live from the raw ledger — then break the books and watch the audit catch it.',
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
          <div className="brand-row">
            <div className="brand-title">Economy Console</div>
            <div className="site-tools">
              {/* biome-ignore lint/a11y/useAnchorContent: aria-label carries the name; the svg is decorative */}
              <a className="icon-link" href="/" aria-label="Documentation">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M8 3.5C6.8 2.5 5 2 2.5 2v10.5c2.5 0 4.3.5 5.5 1.5 1.2-1 3-1.5 5.5-1.5V2C11 2 9.2 2.5 8 3.5Z" />
                  <path d="M8 3.5V14" />
                </svg>
              </a>
              {/* biome-ignore lint/a11y/useAnchorContent: aria-label carries the name; the svg is decorative */}
              <a
                className="icon-link"
                href="https://github.com/pwngh/economy-lab"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="GitHub"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
                </svg>
              </a>
            </div>
          </div>
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
            className="tour-next hint-pulse"
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

  // The one-shot hint's clock steps: a tick per settled navigation re-reads the experiment's
  // position, and tick 0 (prerender + hydration) never pulses.
  const [tick, setTick] = useState(0);
  const idle = navigation.state === 'idle';
  useEffect(() => {
    if (idle) {
      setTick((t) => t + 1);
    }
  }, [idle]);
  const pulse = (control: 'day' | 'jobs') =>
    tick > 0 && !live && hintOn(control);

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
        <SimButton
          op="advance"
          back={back}
          extra={{ days: '1' }}
          busy={busy}
          pulse={pulse('day')}
          onClick={() => advanceHint('day')}
        >
          +1 day
        </SimButton>
        <SimButton op="advance" back={back} extra={{ days: '7' }} busy={busy}>
          +7 days
        </SimButton>
        <SimButton
          op="runJobs"
          back={back}
          busy={busy}
          pulse={pulse('jobs')}
          onClick={() => advanceHint('jobs')}
        >
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
            {solvency.trustCashUsd}
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
  pulse,
  onClick,
  children,
}: {
  op: string;
  back: string;
  extra?: Record<string, string>;
  busy: boolean;
  primary?: boolean;
  pulse?: boolean;
  onClick?: () => void;
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
        className={
          [primary ? 'primary' : '', pulse ? 'hint-pulse' : '']
            .filter(Boolean)
            .join(' ') || undefined
        }
        disabled={busy}
        onClick={onClick}
      >
        {children}
      </button>
    </Form>
  );
}
