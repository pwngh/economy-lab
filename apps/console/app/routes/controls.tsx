/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * The operator's controls: the treasury rate desk (a governed reprice — unlock only when quiesced,
 * set bounded rates, re-lock to resume), the payout provider switch and retry limit, and the
 * reset/clear of the sample economy. These moved off the pages into one place.
 */

import { Form, Link, useLocation, useNavigation } from 'react-router';

import { getEngine } from '~/engine';
import { BackField, PageError, StatusPill, pageMeta } from '~/ui';
import type { Route } from './+types/controls';

export function meta(args: Route.MetaArgs) {
  return pageMeta(
    args,
    'Controls',
    'The operator surface: governed rates, the provider outage switch, retry caps, and reset.',
  );
}

export async function clientLoader() {
  const eco = await getEngine();
  return { rates: await eco.rateBoard(), settings: eco.settings() };
}

export default function Controls({ loaderData }: Route.ComponentProps) {
  const { rates, settings } = loaderData;
  const location = useLocation();
  const back = `${location.pathname}${location.search}`;
  const navigation = useNavigation();
  const busy = navigation.state !== 'idle';

  return (
    <div className="page">
      <div className="view-head">
        <h2>Controls</h2>
        <p>
          The operator&apos;s desk — reprice the treasury, switch the payout
          provider, and reset the sample economy.
        </p>
      </div>

      <RateDesk rates={rates} back={back} busy={busy} />

      <div className="cards grid-2 items-start">
        <div className="card">
          <div className="card-head">
            <h3>Payout provider (Tilia)</h3>
            <p className="card-sub">
              While the provider is down, every payout submit fails; advance a
              day and run jobs to watch each retry climb toward the cap.
            </p>
          </div>
          <Form method="post" action="/actions/simulate">
            <BackField to={back} />
            <input
              type="hidden"
              name="op"
              value={settings.faultMode ? 'faultOff' : 'faultOn'}
            />
            <span className="toggle">
              <StatusPill tone={settings.faultMode ? 'red' : 'green'} dot>
                {settings.faultMode ? 'down' : 'up'}
              </StatusPill>
              <button type="submit" disabled={busy}>
                {settings.faultMode ? 'Bring Tilia back up' : 'Take Tilia down'}
              </button>
            </span>
          </Form>
        </div>

        <div className="card">
          <div className="card-head">
            <h3>Payout retry limit</h3>
            <p className="card-sub">
              Failed attempts before a payout is abandoned and its reserve
              returned to the seller.
            </p>
          </div>
          <Form method="post" action="/actions/simulate" className="row">
            <BackField to={back} />
            <input type="hidden" name="op" value="setMaxAttempts" />
            <input
              type="number"
              name="n"
              min={1}
              aria-label="Payout retry limit"
              defaultValue={settings.maxPayoutAttempts}
            />
            <button type="submit" disabled={busy}>
              Set
            </button>
          </Form>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Sample economy</h3>
          <p className="card-sub">
            Reset restores the starting accounts and activity (and re-locks the
            rate desk). Clear empties everything.
          </p>
        </div>
        <div className="row">
          <Form method="post" action="/actions/simulate">
            <BackField to={back} />
            <input type="hidden" name="op" value="reset" />
            <button type="submit" disabled={busy}>
              Reset
            </button>
          </Form>
          <Form method="post" action="/actions/simulate">
            <BackField to={back} />
            <input type="hidden" name="op" value="clear" />
            <button type="submit" disabled={busy}>
              Clear
            </button>
          </Form>
        </div>
      </div>
    </div>
  );
}

function RateDesk({
  rates,
  back,
  busy,
}: {
  rates: Route.ComponentProps['loaderData']['rates'];
  back: string;
  busy: boolean;
}) {
  const usd = (n: number) => `$${n.toFixed(2)}`;
  return (
    <div className="card">
      <div className="card-head">
        <div className="row between">
          <h3>Rate desk</h3>
          <StatusPill tone={rates.locked ? 'neutral' : 'amber'} dot>
            {rates.locked ? 'Locked' : 'Repricing'}
          </StatusPill>
        </div>
        <p className="card-sub">
          Buy is what a user pays per credit; redemption (par) is what a credit
          cashes out at and what backing values it against — the gap is platform
          margin, per 1,000 credits. Repricing is governed: a payout
          mid-settlement would clear at the wrong rate, so the desk unlocks only
          when none is in flight, which pauses everyday writes until you
          re-lock.
        </p>
      </div>

      <div className="backing-figures">
        <div>
          <div className="stat-label">Buy</div>
          <div className="stat-value">{usd(rates.buyPerThousand)}</div>
          <div className="stat-sub">per 1,000 credits</div>
        </div>
        <div>
          <div className="stat-label">Redemption / payout</div>
          <div className="stat-value">{usd(rates.parPerThousand)}</div>
          <div className="stat-sub">the peg</div>
        </div>
        <div>
          <div className="stat-label">Spread</div>
          <div className="stat-value">{usd(rates.spreadPerThousand)}</div>
          <div className="stat-sub">platform margin</div>
        </div>
      </div>

      {rates.locked ? (
        <div className="drill-section">
          <div className="sb-title">To reprice</div>
          <p
            className={
              rates.inFlightPayouts === 0 ? 'precheck met' : 'precheck unmet'
            }
          >
            {rates.inFlightPayouts === 0
              ? '✓ No payouts in flight — the desk can be unlocked.'
              : `✗ ${rates.inFlightPayouts} payout${rates.inFlightPayouts === 1 ? '' : 's'} in flight. `}
            {rates.inFlightPayouts > 0 ? (
              <Link to="/payouts" className="link">
                Settle or reverse them
              </Link>
            ) : null}
          </p>
          <Form method="post" action="/actions/simulate">
            <BackField to={back} />
            <input type="hidden" name="op" value="unlockRates" />
            <button type="submit" disabled={busy || rates.inFlightPayouts > 0}>
              Unlock rates
            </button>
          </Form>
        </div>
      ) : (
        <div className="drill-section">
          <div className="notice warn">
            Repricing — everyday writes are paused. Set the new rates, then
            re-lock to resume.
          </div>
          <Form
            method="post"
            action="/actions/simulate"
            className="rates-set-form"
          >
            <BackField to={back} />
            <input type="hidden" name="op" value="setRates" />
            <div className="row">
              <div className="field">
                <label htmlFor="rate-buy">Buy (USD / 1,000)</label>
                <input
                  id="rate-buy"
                  name="buy"
                  type="number"
                  min={0}
                  step="0.01"
                  defaultValue={rates.buyPerThousand.toFixed(2)}
                />
              </div>
              <div className="field">
                <label htmlFor="rate-par">Redemption (USD / 1,000)</label>
                <input
                  id="rate-par"
                  name="par"
                  type="number"
                  min={0}
                  step="0.01"
                  defaultValue={rates.parPerThousand.toFixed(2)}
                />
              </div>
              <button type="submit" disabled={busy}>
                Apply rates
              </button>
            </div>
            <div className="sb-note">
              Redemption {usd(rates.parFloor)}–{usd(rates.parCeil)}; buy from
              the redemption rate up to {rates.maxSpreadMultiple}× it. Payout
              follows redemption.
            </div>
          </Form>
          <Form method="post" action="/actions/simulate">
            <BackField to={back} />
            <input type="hidden" name="op" value="lockRates" />
            <button type="submit" disabled={busy}>
              Lock &amp; resume
            </button>
          </Form>
        </div>
      )}
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <PageError error={error} />;
}
