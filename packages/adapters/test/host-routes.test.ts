/**
 * @pwngh/economy-adapters
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
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import Fastify from 'fastify';
import { createApp, withDev } from '@pwngh/economy-core';
import type { App, EconomyModule } from '@pwngh/economy-core';
import { economyExpress } from '../src/express.js';
import { economyFastify } from '../src/fastify.js';
import { submitInit, type Send } from './support/legs.js';

// Deliberately not what any parser round-trips to: whitespace and key order both survive only
// if the bytes did.
const RAW = '{ "exact":"bytes",  "nested":{ "keep":"  spaced  " } }';

const ECONOMY_ECHO = '/economy-echo';
const HOST_ROUTE = '/orders';

const definition: EconomyModule = {
  routes: {
    [`POST ${ECONOMY_ECHO}`]: async ({ request }) =>
      new Response(await request.text()),
  },
};

const economyApp = (): Promise<App> =>
  createApp(withDev(definition), { env: {}, worker: false });

/** The mount owns the app it was handed; the ports bag under it is the app's own, so the
 *  economy is closed after the lifecycle that opened it. */
const closeMount = async (
  mount: { close(): Promise<void> },
  app: App,
): Promise<void> => {
  await mount.close();
  await app.economy.close();
};

const authed = (body: string): RequestInit => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: 'Bearer dev_system_payments',
    'idempotency-key': `idem_${Math.random().toString(36).slice(2)}`,
  },
  body,
});

/**
 * Both halves of the claim, on one server. The economy's own three legs prove the mount still
 * works — a fall-through that answers nothing satisfies "the host route runs" too. Then the
 * host's own routes prove the mount is not terminal and never touched their bodies.
 */
async function bothHalves(send: Send, label: string): Promise<void> {
  assert.equal(
    (await send('/healthz')).status,
    200,
    `${label}: economy healthz`,
  );

  const outcome = (await (await send('/submit', submitInit())).json()) as {
    status?: string;
  };
  assert.equal(outcome.status, 'committed', `${label}: economy authed write`);

  const echoed = await send(ECONOMY_ECHO, authed(RAW));
  assert.equal(echoed.status, 200, `${label}: economy route answered`);
  assert.equal(
    await echoed.text(),
    RAW,
    `${label}: byte-exact body reached the economy`,
  );

  const hostGet = await send(HOST_ROUTE);
  assert.equal(
    hostGet.status,
    200,
    `${label}: the host's own GET ${HOST_ROUTE} answered`,
  );
  assert.deepEqual(
    await hostGet.json(),
    { from: 'host' },
    `${label}: the host answered ${HOST_ROUTE}, not the economy`,
  );

  const hostPost = await send(HOST_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sku: 'starter-pack', qty: 2 }),
  });
  assert.equal(hostPost.status, 200, `${label}: the host's own POST answered`);
  assert.deepEqual(
    await hostPost.json(),
    { parsed: { sku: 'starter-pack', qty: 2 } },
    `${label}: the host's own parser produced its own shape`,
  );
}

test('express: the economy mounts beside a host route with its own body parsing', async () => {
  const app = await economyApp();
  const economy = economyExpress(app);
  const server = express();
  // The documented order: the economy first, so raw bytes reach it, then the host's parser
  // on everything the economy did not claim.
  server.use(economy);
  server.use(express.json());
  server.get(HOST_ROUTE, (_req, res) => {
    res.json({ from: 'host' });
  });
  server.post(HOST_ROUTE, (req, res) => {
    res.json({ parsed: req.body as unknown });
  });
  const listening = server.listen(0, '127.0.0.1');
  await once(listening, 'listening');
  const { port } = listening.address() as AddressInfo;
  try {
    await bothHalves(
      (path, init) => fetch(`http://127.0.0.1:${port}${path}`, init),
      'express',
    );
  } finally {
    await new Promise<void>((done) => listening.close(() => done()));
    await closeMount(economy, app);
  }
});

test('fastify: the economy mounts beside a host route with its own body parsing', async () => {
  const app = await economyApp();
  const economy = economyFastify(app);
  const server = Fastify();
  await server.register(economy as never);
  server.get(HOST_ROUTE, async () => ({ from: 'host' }));
  server.post(HOST_ROUTE, async (request) => ({
    parsed: request.body as unknown,
  }));
  const address = await server.listen({ port: 0, host: '127.0.0.1' });
  try {
    await bothHalves(
      (path, init) => fetch(`${address}${path}`, init),
      'fastify',
    );
  } finally {
    await server.close();
    await closeMount(economy, app);
  }
});

test('express: a throw inside the mount reaches the host error handler', async () => {
  const economy = economyExpress(() => {
    throw new Error('handler exploded');
  });
  const server = express();
  server.use(economy);
  server.use(
    (
      error: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(500).json({ from: 'host error handler', why: error.message });
    },
  );
  const listening = server.listen(0, '127.0.0.1');
  await once(listening, 'listening');
  const { port } = listening.address() as AddressInfo;
  try {
    // Watched, not waited on: without `next(error)` the request never answers, and a bare
    // await would sit here until the run's own ceiling.
    const answered = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(2_000),
    });
    assert.equal(answered.status, 500, 'the host error handler answered');
    assert.deepEqual(await answered.json(), {
      from: 'host error handler',
      why: 'handler exploded',
    });
  } finally {
    await new Promise<void>((done) => listening.close(() => done()));
  }
});
