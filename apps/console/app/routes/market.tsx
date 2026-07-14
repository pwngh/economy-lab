/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * The one page where the economy is driven. Fund a wallet, buy a listing, request a payout — then
 * arm any of the gates the demo relaxes and watch the same forms decline, each rejection rendered
 * with the engine's reason code verbatim and its detail figures. The closing section races the
 * ledger and loses. Each section lives in its own module under app/market/; this composes them.
 */

import { useLocation, useNavigation, useRouteLoaderData } from 'react-router';

import { getEngine } from '~/engine';
import { ActingBar } from '~/market/acting-bar';
import { BreakHarness } from '~/market/break-harness';
import { GateArming } from '~/market/gates';
import { BuyForm, FundForm, PayoutForm } from '~/market/operations';
import { Subscriptions } from '~/market/subscriptions';
import { takeRaceTally } from '~/race';
import { PageError, dayLabel, pageMeta, useFlash } from '~/ui';
import type { Route } from './+types/market';

export function meta(args: Route.MetaArgs) {
  return pageMeta(
    args,
    'Market',
    'Drive the economy — fund, buy, subscribe, cash out — then arm the gates and watch the reason codes.',
  );
}

export async function clientLoader() {
  const eco = await getEngine();
  const [status, page, subscriptions] = await Promise.all([
    eco.status(),
    eco.wallets({ offset: 0, limit: 50 }),
    eco.subscriptions(),
  ]);
  return {
    status,
    settings: eco.settings(),
    users: page.rows.map((w) => w.userId),
    subscriptions,
    // The try-to-break-it tally, if the visitor just ran a burst (one-shot; see ~/race).
    raceTally: takeRaceTally(),
  };
}

export default function Market({ loaderData }: Route.ComponentProps) {
  const { status, settings, users, subscriptions, raceTally } = loaderData;
  const flash = useFlash();
  const actor =
    useRouteLoaderData<{ actor: string | null }>('root')?.actor ?? null;
  const location = useLocation();
  const back = `${location.pathname}${location.search}`;
  const navigation = useNavigation();
  const busy = navigation.state !== 'idle';

  return (
    <div className="page">
      <div className="view-head">
        <h2>Market</h2>
        <p>
          Drive the economy, then provoke its gates. Every rejection comes back
          as data — its reason code, verbatim, beside the reason in plain
          English and the figures the engine reported. The dedup and funds gates
          are explained in{' '}
          <a className="link" href="/economy/concepts/idempotency/">
            idempotency
          </a>{' '}
          and{' '}
          <a className="link" href="/economy/concepts/concurrency/">
            concurrency
          </a>
          .
        </p>
      </div>

      {status.paused ? (
        <div className="notice warn" aria-live="polite">
          A maintenance window is in effect, so everyday writes decline as{' '}
          <code className="reason-code">ECONOMY_PAUSED</code>. Settlement and
          operator fixes still run. Resumes{' '}
          {status.resumesAt === null
            ? 'once reopened'
            : dayLabel(status.resumesAt)}
          .
        </div>
      ) : null}

      <ActingBar users={users} actor={actor} back={back} busy={busy} />

      <div className="cards market-ops items-start">
        <BuyForm
          flash={flash}
          users={users}
          actor={actor}
          back={back}
          busy={busy}
        />
        <PayoutForm
          flash={flash}
          users={users}
          actor={actor}
          back={back}
          busy={busy}
        />
      </div>

      <FundForm flash={flash} users={users} back={back} busy={busy} />

      <GateArming settings={settings} back={back} busy={busy} />

      <Subscriptions
        flash={flash}
        subscriptions={subscriptions}
        users={users}
        back={back}
        busy={busy}
      />

      <BreakHarness
        flash={flash}
        users={users}
        back={back}
        busy={busy}
        raceTally={raceTally}
      />
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <PageError error={error} />;
}
