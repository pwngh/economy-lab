/**
 * @pwngh/economy-lab
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * The outbox -> relay -> inbox pipeline, watched. Every committed operation writes an event to the
 * outbox in the same transaction as its posting; the relay delivers pending rows through a console
 * capture dispatcher (the sandbox makes no outbound calls). Inbound, a verified provider webhook
 * applies at most once: post the same event id twice and the second is a duplicate that posts
 * nothing.
 */

import { Form, Link, useLocation, useNavigation } from 'react-router';

import { getEngine } from '~/engine';
import type { Flash } from '~/flash';
import {
  BackField,
  Credits,
  DataTable,
  Entity,
  FlashBanner,
  PageError,
  StatusPill,
  dayLabel,
  entityName,
  pageMeta,
  useFlash,
} from '~/ui';
import type { Route } from './+types/pipeline';

export function meta(args: Route.MetaArgs) {
  return pageMeta(
    args,
    'Pipeline',
    'Events cross the edge exactly once: outbox relay and webhook dedup, watched live.',
  );
}

export async function clientLoader() {
  const eco = await getEngine();
  const page = await eco.wallets({ offset: 0, limit: 50 });
  return {
    delivered: eco.pipeline().delivered,
    wallets: page.rows,
  };
}

function fieldError(flash: Flash | null, name: string): string | null {
  if (flash && flash.kind === 'invalid' && flash.form === 'pipeline-webhook') {
    return flash.fields[name] ?? null;
  }
  return null;
}

export default function Pipeline({ loaderData }: Route.ComponentProps) {
  const { delivered, wallets } = loaderData;
  const flash = useFlash();
  const location = useLocation();
  const back = `${location.pathname}${location.search}`;
  const navigation = useNavigation();
  const busy = navigation.state !== 'idle';
  const users = wallets.map((w) => w.userId);
  const eventIdError = fieldError(flash, 'eventId');
  const creditsError = fieldError(flash, 'credits');

  return (
    <div className="page">
      <div className="view-head">
        <h2>Event pipeline</h2>
        <p>
          The outbox, the relay, and the inbox — the event backbone. Every money
          posting co-commits its event; the same event never applies twice.
        </p>
      </div>

      <div className="cards market-ops items-start">
        <div className="card">
          <h3>Inbound webhook</h3>
          <p className="card-sub">
            A verified provider callback tops up a wallet. Post it, then post it
            again with the same event id — the second is a duplicate and the
            balance rises only once.
          </p>
          <div aria-live="polite" className="owned-flash">
            {flash && flash.form === 'pipeline-webhook' ? (
              <FlashBanner flash={flash} />
            ) : null}
          </div>
          <Form method="post" action="/actions/pipeline">
            <BackField to={back} />
            <input type="hidden" name="op" value="webhook" />
            <div className="field">
              <label htmlFor="wh-event">Provider event id</label>
              <input
                id="wh-event"
                name="eventId"
                defaultValue="evt_demo_1"
                aria-describedby={eventIdError ? 'wh-event-error' : undefined}
              />
              {eventIdError ? (
                <div id="wh-event-error" className="field-error">
                  {eventIdError}
                </div>
              ) : null}
            </div>
            <div className="row">
              <div className="field">
                <label htmlFor="wh-user">User</label>
                <select id="wh-user" name="userId" defaultValue="usr_alice">
                  {users.map((u) => (
                    <option key={u} value={u}>
                      {entityName(u)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="wh-credits">Credits</label>
                <input
                  id="wh-credits"
                  name="credits"
                  type="number"
                  min={0}
                  max={10_000_000_000_000}
                  defaultValue={250}
                  aria-describedby={
                    creditsError ? 'wh-credits-error' : undefined
                  }
                />
                {creditsError ? (
                  <div id="wh-credits-error" className="field-error">
                    {creditsError}
                  </div>
                ) : null}
              </div>
            </div>
            <button type="submit" className="primary full" disabled={busy}>
              Post webhook
            </button>
          </Form>
        </div>

        <div className="card">
          <h3>Wallet balances</h3>
          <p className="card-sub">
            Watch the purchased balance rise by the top-up amount — once,
            however many times the same event is delivered.
          </p>
          {wallets.length === 0 ? (
            <div className="empty">No users yet.</div>
          ) : (
            <DataTable
              columns={[
                { key: 'user', label: 'User' },
                { key: 'purchased', label: 'Purchased', num: true },
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
                </tr>
              ))}
            </DataTable>
          )}
        </div>
      </div>

      <div className="card card-flush">
        <div className="card-head">
          <div className="row between">
            <h3>Outbound relay</h3>
            <Form method="post" action="/actions/pipeline">
              <BackField to={back} />
              <input type="hidden" name="op" value="relay" />
              <button type="submit" className="primary" disabled={busy}>
                Run the relay
              </button>
            </Form>
          </div>
          <p className="card-sub">
            The relay claims the pending outbox rows and delivers each through a
            console capture dispatcher — no network call leaves the sandbox, so
            the delivered payloads are shown verbatim here.
          </p>
        </div>
        {delivered.length === 0 ? (
          <div className="empty">
            Nothing delivered yet. Run the relay to drain the outbox.
          </div>
        ) : (
          <DataTable
            columns={[
              { key: 'type', label: 'Event' },
              { key: 'subject', label: 'About' },
              { key: 'audience', label: 'Audience' },
              { key: 'when', label: 'When' },
            ]}
          >
            {delivered.map((e) => (
              <tr key={e.id}>
                <td className="mono">{e.type}</td>
                <td>
                  {e.subject.startsWith('txn_') ? (
                    <Link to={`/ledger/txn/${e.subject}`} className="link mono">
                      {e.subject}
                    </Link>
                  ) : (
                    entityName(e.subject)
                  )}
                </td>
                <td>
                  <StatusPill
                    tone={e.audience === 'client' ? 'blue' : 'neutral'}
                  >
                    {e.audience}
                  </StatusPill>
                </td>
                <td className="dim">{dayLabel(e.at)}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </div>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <PageError error={error} />;
}
