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
 * ledger and loses.
 */

import {
  Form,
  Link,
  useLocation,
  useNavigation,
  useRouteLoaderData,
} from 'react-router';

import { getEngine } from '~/engine';
import type { Flash } from '~/flash';
import {
  DataTable,
  FlashBanner,
  PageError,
  StatusPill,
  dayLabel,
  entityName,
  fmtAmount,
  pageMeta,
  useFlash,
} from '~/ui';
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
  };
}

// The acting-as options. The empty value is "natural" — each form acts as its own buyer or seller,
// so the gates apply. A seed identity acts as that user (act on a wallet it doesn't own to provoke
// the authorization gate); Platform / Operator act with privilege, bypassing the pause and
// authorization gates.
function actorOptions(users: string[]): { value: string; label: string }[] {
  return [
    { value: '', label: 'Natural — the buyer or seller' },
    { value: 'system', label: 'Platform (privileged)' },
    { value: 'operator', label: 'Operator (privileged)' },
    ...users.map((id) => ({ value: id, label: entityName(id) })),
  ];
}

function fieldError(
  flash: Flash | null,
  form: string,
  name: string,
): string | null {
  if (flash && flash.kind === 'invalid' && flash.form === form) {
    return flash.fields[name] ?? null;
  }
  return null;
}

// The flash the given form owns, in its own aria-live region beside the form. The region is always
// mounted so a screen reader announces the message that arrives into it after a submit.
function OwnedFlash({ flash, form }: { flash: Flash | null; form: string }) {
  const owned = flash && flash.form === form ? flash : null;
  return (
    <div aria-live="polite" className="owned-flash">
      {owned ? <FlashBanner flash={owned} /> : null}
    </div>
  );
}

function FieldNote({ id, error }: { id: string; error: string | null }) {
  return error ? (
    <div id={id} className="field-error">
      {error}
    </div>
  ) : null;
}

export default function Market({ loaderData }: Route.ComponentProps) {
  const { status, settings, users, subscriptions } = loaderData;
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

      <Form method="post" action="/actions/actor" className="acting-bar">
        <input type="hidden" name="back" value={back} />
        <label htmlFor="acting-actor">Acting as</label>
        <select id="acting-actor" name="actor" defaultValue={actor ?? ''}>
          {actorOptions(users).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button type="submit" disabled={busy}>
          Switch
        </button>
        <span className="acting-note">
          By default each purchase and payout submits as its own owner, so the
          gates apply. Switch to another identity to act on a wallet you
          don&apos;t own (the authorization gate refuses it), or to Platform /
          Operator to act with privilege — bypassing the maintenance and
          authorization gates the way a real operator does.
        </span>
      </Form>

      <div className="cards market-ops items-start">
        <div className="card">
          <h3>Buy a listing</h3>
          <p className="card-sub">
            A spend splits the buyer&apos;s credits to the seller&apos;s earned
            balance. Reuse an order id to trip <code>DUPLICATE_ORDER</code>, or
            name a recipient to gift the entitlement.
          </p>
          <OwnedFlash flash={flash} form="market-purchase" />
          <Form method="post" action="/actions/record">
            <input type="hidden" name="back" value={back} />
            <input type="hidden" name="type" value="purchase" />
            <input type="hidden" name="form" value="market-purchase" />
            {actor ? <input type="hidden" name="actor" value={actor} /> : null}
            <div className="row">
              <div className="field">
                <label htmlFor="buy-user">Buyer</label>
                <UserSelect
                  id="buy-user"
                  name="user"
                  users={users}
                  fallback="usr_alice"
                />
                <FieldNote
                  id="buy-user-error"
                  error={fieldError(flash, 'market-purchase', 'user')}
                />
              </div>
              <div className="field">
                <label htmlFor="buy-seller">Seller</label>
                <UserSelect
                  id="buy-seller"
                  name="seller"
                  users={users}
                  fallback="usr_nova"
                />
                <FieldNote
                  id="buy-seller-error"
                  error={fieldError(flash, 'market-purchase', 'seller')}
                />
              </div>
            </div>
            <div className="field">
              <label htmlFor="buy-listing">Listing</label>
              <input
                id="buy-listing"
                name="listing"
                defaultValue="Aurora Avatar"
              />
            </div>
            <div className="row">
              <div className="field">
                <label htmlFor="buy-credits">Credits</label>
                <input
                  id="buy-credits"
                  name="credits"
                  type="number"
                  min={0}
                  defaultValue={500}
                  aria-describedby={
                    fieldError(flash, 'market-purchase', 'credits')
                      ? 'buy-credits-error'
                      : undefined
                  }
                />
                <FieldNote
                  id="buy-credits-error"
                  error={fieldError(flash, 'market-purchase', 'credits')}
                />
              </div>
              <div className="field">
                <label htmlFor="buy-order">Order id (optional)</label>
                <input
                  id="buy-order"
                  name="orderId"
                  placeholder="reuse to duplicate"
                />
              </div>
            </div>
            <div className="field">
              <label htmlFor="buy-gift">
                Gift the entitlement to (optional)
              </label>
              <UserSelect
                id="buy-gift"
                name="giftTo"
                users={users}
                fallback=""
                allowNone
              />
            </div>
            <button type="submit" className="primary full" disabled={busy}>
              {busy ? 'Submitting…' : 'Buy'}
            </button>
          </Form>
        </div>

        <div className="card">
          <h3>Request a payout</h3>
          <p className="card-sub">
            A seller cashes out earned credits. Below the minimum, too soon
            after the last request, still maturing, or short of balance — each
            declines with its own reason.
          </p>
          <OwnedFlash flash={flash} form="market-payout" />
          <Form method="post" action="/actions/record">
            <input type="hidden" name="back" value={back} />
            <input type="hidden" name="type" value="payout" />
            <input type="hidden" name="form" value="market-payout" />
            {actor ? <input type="hidden" name="actor" value={actor} /> : null}
            <div className="field">
              <label htmlFor="pay-user">Seller</label>
              <UserSelect
                id="pay-user"
                name="user"
                users={users}
                fallback="usr_nova"
              />
              <FieldNote
                id="pay-user-error"
                error={fieldError(flash, 'market-payout', 'user')}
              />
            </div>
            <div className="field">
              <label htmlFor="pay-credits">Credits</label>
              <input
                id="pay-credits"
                name="credits"
                type="number"
                min={0}
                defaultValue={100}
                aria-describedby={
                  fieldError(flash, 'market-payout', 'credits')
                    ? 'pay-credits-error'
                    : undefined
                }
              />
              <FieldNote
                id="pay-credits-error"
                error={fieldError(flash, 'market-payout', 'credits')}
              />
            </div>
            <button type="submit" className="primary full" disabled={busy}>
              {busy ? 'Submitting…' : 'Request payout'}
            </button>
          </Form>
        </div>
      </div>

      <Form method="post" action="/actions/record" className="card fund-card">
        <input type="hidden" name="back" value={back} />
        <input type="hidden" name="form" value="market-fund" />
        <h3>Fund a wallet</h3>
        <p className="card-sub">
          Top up purchased credits or grant promotional credits — what a wallet
          needs before it can spend.
        </p>
        <OwnedFlash flash={flash} form="market-fund" />
        <div className="fund-row">
          <div className="field">
            <label htmlFor="fund-type">Operation</label>
            <select id="fund-type" name="type" defaultValue="deposit">
              <option value="deposit">Deposit (buy credits)</option>
              <option value="promo">Grant promo</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="fund-user">User</label>
            <UserSelect
              id="fund-user"
              name="user"
              users={users}
              fallback="usr_alice"
            />
            <FieldNote
              id="fund-user-error"
              error={fieldError(flash, 'market-fund', 'user')}
            />
          </div>
          <div className="field">
            <label htmlFor="fund-credits">Credits</label>
            <input
              id="fund-credits"
              name="credits"
              type="number"
              min={0}
              defaultValue={1000}
              aria-describedby={
                fieldError(flash, 'market-fund', 'credits')
                  ? 'fund-credits-error'
                  : undefined
              }
            />
            <FieldNote
              id="fund-credits-error"
              error={fieldError(flash, 'market-fund', 'credits')}
            />
          </div>
          <button type="submit" disabled={busy}>
            Fund
          </button>
        </div>
      </Form>

      <div className="card card-flush">
        <div className="card-head">
          <h3>Arm a gate</h3>
          <p className="card-sub">
            The demo relaxes these five gates so everyday flow goes through. Arm
            one, then submit above to watch it decline. Each mutates the engine
            config in place, so the next submit sees it.
          </p>
        </div>
        <div className="gate-grid">
          <KnobForm
            back={back}
            op="setMaturity"
            field="days"
            label="Maturity hold (days)"
            value={settings.maturityHorizonDays}
            arms="FUNDS_IMMATURE"
            busy={busy}
          />
          <KnobForm
            back={back}
            op="setVelocity"
            field="credits"
            label="Velocity limit (credits / window)"
            value={settings.velocityLimitCredits}
            arms="RISK_DENIED"
            busy={busy}
          />
          <KnobForm
            back={back}
            op="setPayoutMin"
            field="credits"
            label="Minimum cash-out (credits)"
            value={settings.payoutMinimumCredits}
            arms="BELOW_MINIMUM"
            busy={busy}
          />
          <KnobForm
            back={back}
            op="setPayoutInterval"
            field="days"
            label="Cash-out interval (days)"
            value={settings.payoutIntervalDays}
            arms="PAYOUT_TOO_SOON"
            busy={busy}
          />
          <div className="gate-knob">
            <div className="sb-title">Maintenance window</div>
            <Form method="post" action="/actions/simulate" className="row">
              <input type="hidden" name="back" value={back} />
              <input
                type="hidden"
                name="op"
                value={
                  settings.maintenancePaused
                    ? 'maintenanceOff'
                    : 'maintenanceOn'
                }
              />
              <StatusPill
                tone={settings.maintenancePaused ? 'red' : 'green'}
                dot
              >
                {settings.maintenancePaused ? 'paused' : 'open'}
              </StatusPill>
              <button type="submit" disabled={busy}>
                {settings.maintenancePaused ? 'Reopen economy' : 'Open window'}
              </button>
            </Form>
            <div className="sb-note">
              Arms <code className="reason-code">ECONOMY_PAUSED</code> for
              everyday user writes; Platform and operator writes still go
              through. Advance a day to clear it.
            </div>
          </div>
        </div>
      </div>

      <div className="card" id="subscriptions">
        <h3>Subscriptions</h3>
        <p className="card-sub">
          A subscription charges its first period at open; the worker&apos;s
          sweep bills each due period as time advances, and lapses it after
          repeated failures once the wallet runs dry. One active subscription
          per user, seller, and sku — a duplicate is refused.
        </p>
        <OwnedFlash flash={flash} form="market-subscribe" />
        {subscriptions.length > 0 ? (
          <DataTable
            columns={[
              { key: 'sku', label: 'Subscription' },
              { key: 'who', label: 'Subscriber → seller' },
              { key: 'price', label: 'Per period', num: true },
              { key: 'period', label: 'Period #', num: true },
              { key: 'due', label: 'Next due' },
              { key: 'state', label: 'State' },
              { key: 'cancel', label: 'Actions' },
            ]}
          >
            {subscriptions.map((s) => (
              <tr key={s.id}>
                <td>{s.sku}</td>
                <td>
                  {entityName(s.userId)} → {entityName(s.sellerId)}
                </td>
                <td className="num mono">
                  {fmtAmount(s.priceCredits)} Cr / {s.periodDays}d
                </td>
                <td className="num mono">{s.period}</td>
                <td className="mono">
                  {s.state === 'ACTIVE' ? dayLabel(s.nextDueAt) : '—'}
                </td>
                <td>
                  <StatusPill
                    tone={
                      s.state === 'ACTIVE'
                        ? 'green'
                        : s.state === 'LAPSED'
                          ? 'red'
                          : 'blue'
                    }
                    dot
                  >
                    {s.state}
                  </StatusPill>
                </td>
                <td>
                  {s.state === 'ACTIVE' ? (
                    <Form method="post" action="/actions/subscribe">
                      <input type="hidden" name="back" value={back} />
                      <input type="hidden" name="op" value="cancel" />
                      <input type="hidden" name="id" value={s.id} />
                      <button
                        type="submit"
                        className="btn small"
                        disabled={busy}
                      >
                        Cancel
                      </button>
                    </Form>
                  ) : null}
                </td>
              </tr>
            ))}
          </DataTable>
        ) : null}
        <Form method="post" action="/actions/subscribe" className="mt-3">
          <input type="hidden" name="back" value={back} />
          <input type="hidden" name="op" value="subscribe" />
          <div className="row">
            <div className="field">
              <label htmlFor="sub-user">Subscriber</label>
              <UserSelect
                id="sub-user"
                name="user"
                users={users}
                fallback="usr_alice"
              />
              <FieldNote
                id="sub-user-error"
                error={fieldError(flash, 'market-subscribe', 'user')}
              />
            </div>
            <div className="field">
              <label htmlFor="sub-seller">Seller</label>
              <UserSelect
                id="sub-seller"
                name="seller"
                users={users}
                fallback="usr_nova"
              />
              <FieldNote
                id="sub-seller-error"
                error={fieldError(flash, 'market-subscribe', 'seller')}
              />
            </div>
          </div>
          <div className="row">
            <div className="field">
              <label htmlFor="sub-sku">Subscription</label>
              <input id="sub-sku" name="sku" defaultValue="Aurora Fan Club" />
              <FieldNote
                id="sub-sku-error"
                error={fieldError(flash, 'market-subscribe', 'sku')}
              />
            </div>
            <div className="field">
              <label htmlFor="sub-credits">Credits / period</label>
              <input
                id="sub-credits"
                name="credits"
                type="number"
                min="1"
                defaultValue="100"
              />
              <FieldNote
                id="sub-credits-error"
                error={fieldError(flash, 'market-subscribe', 'credits')}
              />
            </div>
            <div className="field">
              <label htmlFor="sub-days">Period (days)</label>
              <input
                id="sub-days"
                name="days"
                type="number"
                min="1"
                defaultValue="7"
              />
              <FieldNote
                id="sub-days-error"
                error={fieldError(flash, 'market-subscribe', 'days')}
              />
            </div>
          </div>
          <button type="submit" disabled={busy}>
            Subscribe
          </button>
        </Form>
      </div>

      <div className="card break-card" id="race">
        <div className="card-head">
          <h3>Try to break it</h3>
          <p className="card-sub">
            Fire a burst of purchases at one engine. The idempotent ledger
            commits exactly one and the balance moves once — the same guarantee
            the conformance race suite proves under true parallelism on the
            Postgres and MySQL engines.
          </p>
        </div>
        <OwnedFlash flash={flash} form="market-break" />
        <Form method="post" action="/actions/market" className="break-form">
          <input type="hidden" name="back" value={back} />
          <input type="hidden" name="form" value="market-break" />
          <div className="row">
            <div className="field">
              <label htmlFor="break-buyer">Buyer</label>
              <UserSelect
                id="break-buyer"
                name="buyer"
                users={users}
                fallback="usr_alice"
              />
            </div>
            <div className="field">
              <label htmlFor="break-seller">Seller</label>
              <UserSelect
                id="break-seller"
                name="seller"
                users={users}
                fallback="usr_nova"
              />
            </div>
            <div className="field">
              <label htmlFor="break-credits">Credits each</label>
              <input
                id="break-credits"
                name="credits"
                type="number"
                min={0}
                defaultValue={200}
              />
            </div>
            <div className="field">
              <label htmlFor="break-count">Concurrent</label>
              <input
                id="break-count"
                name="count"
                type="number"
                min={2}
                max={12}
                defaultValue={6}
              />
            </div>
          </div>
          <div className="row break-buttons">
            <button type="submit" name="op" value="race" disabled={busy}>
              Double-spend one order
            </button>
            <button type="submit" name="op" value="drain" disabled={busy}>
              Drain the wallet
            </button>
          </div>
        </Form>
        <p className="card-sub">
          <Link to="/integrity" className="link">
            Prove the books still balance
          </Link>{' '}
          after the race.
        </p>
      </div>
    </div>
  );
}

// A select of the seed identities. `fallback` is the default when it is one of the users; when
// `allowNone` is set the first option is an empty "no one" for optional recipients.
function UserSelect({
  id,
  name,
  users,
  fallback,
  allowNone,
}: {
  id: string;
  name: string;
  users: string[];
  fallback: string;
  allowNone?: boolean;
}) {
  const known = users.includes(fallback);
  return (
    <select id={id} name={name} defaultValue={known ? fallback : ''}>
      {allowNone ? <option value="">No one (self-purchase)</option> : null}
      {!known && !allowNone ? (
        <option value={fallback}>{fallback}</option>
      ) : null}
      {users.map((u) => (
        <option key={u} value={u}>
          {entityName(u)}
        </option>
      ))}
    </select>
  );
}

// One gate knob: a labelled number posting to the sim endpoint, with the reason code it arms.
function KnobForm({
  back,
  op,
  field,
  label,
  value,
  arms,
  busy,
}: {
  back: string;
  op: string;
  field: string;
  label: string;
  value: number;
  arms: string;
  busy: boolean;
}) {
  return (
    <div className="gate-knob">
      <Form method="post" action="/actions/simulate">
        <input type="hidden" name="back" value={back} />
        <input type="hidden" name="op" value={op} />
        <div className="field">
          <label htmlFor={`knob-${op}`}>{label}</label>
          <div className="row">
            <input
              id={`knob-${op}`}
              name={field}
              type="number"
              min={0}
              defaultValue={value}
            />
            <button type="submit" disabled={busy}>
              Set
            </button>
          </div>
        </div>
      </Form>
      <div className="sb-note">
        Arms <code className="reason-code">{arms}</code>.
      </div>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <PageError error={error} />;
}
