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
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import Fastify from 'fastify';
import { createEconomy, createServer, memoryPorts } from '@pwngh/economy-lab';
import { createApp, withDev } from '@pwngh/economy-core';
import { economyExpress } from '../src/express.js';
import { economyFastify } from '../src/fastify.js';
import type { FetchLike } from '../src/lib/mount.js';
import { faceLegs, type Send } from './support/legs.js';

const SECRET = 'whsec_adapter_test';
const WEBHOOK_BODY = JSON.stringify({
  eventId: 'evt_raw_1',
  provider: 'tilia',
  nested: { keep: 'exact bytes' },
});

// One fetch handler with all three legs: dev-token auth on /submit, and a webhook route whose
// HMAC check is the raw-body detector — if a framework's parser touches one byte, it 401s.
async function makeHandler(): Promise<{
  handler: FetchLike;
  close: () => Promise<void>;
}> {
  const app = await createApp(withDev({}), { env: {} });
  const ports = memoryPorts({
    signingKey: 'adapter-test',
    secrets: { webhookSecret: SECRET },
  });
  const economy = createEconomy(ports);
  const webhook = createServer({
    economy,
    ports,
    authenticate: false,
    webhook: async (_provider, request) =>
      new Response(await request.text(), { status: 200 }),
  });
  const handler: FetchLike = (request) =>
    new URL(request.url).pathname.startsWith('/webhooks/')
      ? webhook(request)
      : app.handler(request);
  return {
    handler,
    close: async () => {
      await app.close();
      await economy.close();
    },
  };
}

function signedWebhookInit(): RequestInit {
  const signature = createHmac('sha256', SECRET)
    .update(WEBHOOK_BODY)
    .digest('hex');
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-signature': signature,
      'x-timestamp': String(Date.now()),
    },
    body: WEBHOOK_BODY,
  };
}

// The three legs every adapter must pass through its own pipeline.
async function legs(send: Send, label: string): Promise<void> {
  await faceLegs(send, label);
  const hook = await send('/webhooks/tilia', signedWebhookInit());
  assert.equal(hook.status, 200, 'webhook HMAC verified — raw bytes survived');
  assert.equal(
    await hook.text(),
    WEBHOOK_BODY,
    'byte-exact body through the pipeline',
  );
}

// The fallback recipe: a host that cannot mount the economy before its own parser hands it
// raw bytes instead. The primary recipe — the economy first, nothing in front of it — is in
// host-routes.test.ts, where the host's own routes prove it.
test('express: the raw-body fallback carries a webhook byte for byte', async () => {
  const { handler, close } = await makeHandler();
  const server = express();
  server.use(express.raw({ type: '*/*' }));
  server.use(economyExpress(handler));
  const listening = server.listen(0);
  const port = (listening.address() as AddressInfo).port;
  try {
    await legs(
      (path, init) => fetch(`http://127.0.0.1:${port}${path}`, init),
      'express',
    );
  } finally {
    listening.close();
    await close();
  }
});

test('fastify: encapsulated buffer parser keeps bytes exact', async () => {
  const { handler, close } = await makeHandler();
  const server = Fastify();
  await server.register(economyFastify(handler) as never);
  const address = await server.listen({ port: 0 });
  try {
    await legs((path, init) => fetch(`${address}${path}`, init), 'fastify');
  } finally {
    await server.close();
    await close();
  }
});
