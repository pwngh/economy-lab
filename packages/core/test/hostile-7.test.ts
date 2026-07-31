/**
 * @pwngh/economy-core
 *
 * Copyright (c) Preston Neal
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEconomyModule, OWN_SUBJECT } from '../src/module.js';
import { composeRoutes } from '../src/routes.js';
import { userActor } from '@pwngh/economy-auth';
import type { Authenticate, Principal } from '@pwngh/economy-auth';
import type { RouteHandler } from '../src/index.js';
import type { Economy, Operation } from '@pwngh/economy-lab';

// A recording economy: captures the exact Operation the routes seam submits, answers a
// canned rejection so the response path completes.
function recorder() {
  const seen: Operation[] = [];
  const economy = {
    submit: async (op: Operation) => {
      seen.push(op);
      return {
        status: 'rejected',
        detail: { reason: 'CAPTURED' },
      } as unknown as ReturnType<Economy['submit']> extends Promise<infer R>
        ? R
        : never;
    },
  } as unknown as Economy;
  return { economy, seen };
}

const labHandler = async () => new Response('lab', { status: 404 });

function seam(
  routes: Record<string, RouteHandler>,
  principal: Principal | null,
) {
  const authenticate: Authenticate = async () => principal;
  const mod = resolveEconomyModule({ authenticate, routes });
  const { economy, seen } = recorder();
  return {
    handler: composeRoutes(mod, { economy, authenticate }, labHandler),
    seen,
  };
}

test('hostile-7.1: cancelSubscription own-subject — no bogus userId injected (contract has none)', async () => {
  // The operation kind cancelSubscription has no userId field; its subject is subscriptionId.
  // A user principal submitting it must not have a fabricated userId stamped on.
  const { handler, seen } = seam(
    {
      'POST /cancel': (() => ({
        kind: 'cancelSubscription',
        subscriptionId: 'sub_1',
      })) as RouteHandler,
    },
    userActor('usr_ada'),
  );
  const res = await handler(
    new Request('http://t/cancel', {
      method: 'POST',
      headers: { 'idempotency-key': 'k1' },
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  assert.ok(
    !('userId' in (seen[0] as Record<string, unknown>)),
    'the caller id was fabricated onto an operation that has no userId subject',
  );
});

test('hostile-7.2: OWN_SUBJECT names only fields the operation actually carries', () => {
  // Every entry must name a real field on that operation kind. cancelSubscription carries no
  // userId — an entry for it is a table error.
  assert.equal(
    OWN_SUBJECT.cancelSubscription,
    undefined,
    'cancelSubscription has no own-subject field (subscriptionId identifies it)',
  );
});

test('hostile-7.3: authenticate:false with actor:null is refused, not submitted', async () => {
  // `authenticate: false` "trusts the handler to set the actor — requires it." A null actor
  // is not an actor; it must be refused, never handed to submit.
  const routes = {
    'POST /grant': (() => ({
      kind: 'topUp',
      userId: 'usr_x',
      amount: 10,
      source: 't',
      actor: null,
    })) as unknown as RouteHandler,
  };
  const mod = resolveEconomyModule({ authenticate: false, routes });
  const { economy, seen } = recorder();
  const handler = composeRoutes(
    mod,
    { economy, authenticate: false },
    labHandler,
  );
  const res = await handler(
    new Request('http://t/grant', {
      method: 'POST',
      headers: { 'idempotency-key': 'k2' },
    }),
  );
  assert.equal(seen.length, 0, 'an actor:null draft reached submit');
  assert.equal(
    res.status,
    400,
    'the actorless refusal must fire on a null actor',
  );
});

// The Node bridge's client-address stamp: an inbound spoof is stripped even when the
// socket offers no address to overwrite it with (the bridges fixed the same class).
test('toRequest never lets a client speak for its own address', async () => {
  const { toRequest } = await import('../src/internal.js');
  const { CLIENT_IP_HEADER } = await import('@pwngh/economy-lab/server');
  const spoofed = {
    method: 'GET',
    url: '/v1/wallet',
    headers: { host: 'x.test', [CLIENT_IP_HEADER]: '127.0.0.1' },
    socket: {},
  } as unknown as import('node:http').IncomingMessage;
  assert.equal(
    toRequest(spoofed).headers.get(CLIENT_IP_HEADER),
    null,
    "no socket address means no client-address header, never the client's claim",
  );
  const real = {
    ...spoofed,
    socket: { remoteAddress: '203.0.113.9' },
  } as unknown as import('node:http').IncomingMessage;
  assert.equal(
    toRequest(real).headers.get(CLIENT_IP_HEADER),
    '203.0.113.9',
    "the socket's own address wins over the inbound claim",
  );
});
