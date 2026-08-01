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

import { createHmac } from 'node:crypto';
import { createEconomy, createServer, memoryPorts } from '@pwngh/economy-lab';
import { createApp, withDev } from '@pwngh/economy-core';
import type { FetchLike } from '../src/lib/mount.ts';

const SECRET = 'whsec_matrix';
const WEBHOOK_BODY = JSON.stringify({
  eventId: 'evt_matrix_1',
  provider: 'tilia',
  nested: { keep: 'exact bytes' },
});

// Negative-control hook: names one leg whose request input is corrupted so its check must fail.
const BREAK = process.env.MATRIX_SMOKE_BREAK ?? '';

async function makeHandler(): Promise<{
  handler: FetchLike;
  close: () => Promise<void>;
}> {
  const app = await createApp(withDev({}), { env: {} });
  const ports = memoryPorts({
    signingKey: 'matrix',
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
  const secret = BREAK === 'webhook' ? `${SECRET}_broken` : SECRET;
  const signature = createHmac('sha256', secret)
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

const submitInit = (): RequestInit => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization:
      BREAK === 'submit' ? 'Bearer not_a_token' : 'Bearer dev_system_payments',
  },
  body: JSON.stringify({
    kind: 'topUp',
    idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
    userId: 'usr_ada',
    amount: 'CREDIT:100.00',
    source: 'card',
  }),
});

const fail = (leg: string, detail: string): never => {
  throw new Error(`${leg}: ${detail}`);
};

// Each leg prints its own evidence line only after its checks pass; the matrix requires all three.
async function legs(
  send: (path: string, init?: RequestInit) => Promise<Response>,
): Promise<void> {
  const health = await send(
    BREAK === 'healthz' ? '/healthz-broken' : '/healthz',
  );
  if (health.status !== 200) fail('healthz', `status ${health.status}`);
  process.stdout.write('leg ok healthz\n');
  const submitted = await (await send('/submit', submitInit())).text();
  let status = '';
  try {
    status = (JSON.parse(submitted) as { status?: string }).status ?? '';
  } catch {
    /* non-JSON is a failure */
  }
  if (status !== 'committed') fail('submit', submitted);
  process.stdout.write('leg ok submit\n');
  const hook = await send('/webhooks/tilia', signedWebhookInit());
  if (hook.status !== 200) fail('webhook', `status ${hook.status}`);
  if ((await hook.text()) !== WEBHOOK_BODY)
    fail('webhook', 'body bytes changed in the pipeline');
  process.stdout.write('leg ok webhook\n');
}

type Cleanup = () => void | Promise<void>;
type Send = (path: string, init?: RequestInit) => Promise<Response>;

// Socket mounts fetch over 127.0.0.1; fetch-native shapes take the Request in-process.
async function mount(
  adapter: string,
  handler: FetchLike,
): Promise<{ send: Send; cleanup: Cleanup }> {
  const overSocket =
    (port: number): Send =>
    (path, init) =>
      fetch(`http://127.0.0.1:${port}${path}`, init);
  if (adapter === 'express') {
    const { default: express } = await import('express');
    const { economyExpress } = await import('../src/express.ts');
    const server = express();
    server.use(express.raw({ type: '*/*' }));
    server.use(economyExpress(handler));
    const listening = server.listen(0, '127.0.0.1');
    await new Promise((r) => listening.once('listening', r));
    const { port } = listening.address() as { port: number };
    return {
      send: overSocket(port),
      cleanup: () => new Promise((r) => listening.close(() => r())),
    };
  }
  if (adapter === 'fastify') {
    const { default: Fastify } = await import('fastify');
    const { economyFastify } = await import('../src/fastify.ts');
    const server = Fastify();
    await server.register(economyFastify(handler) as never);
    const address = await server.listen({ port: 0, host: '127.0.0.1' });
    return {
      send: (path, init) => fetch(`${address}${path}`, init),
      cleanup: () => server.close(),
    };
  }
  return fail('adapter', `unknown "${adapter}"`);
}

const adapter = process.argv[2] ?? '';
const { handler, close } = await makeHandler();
const { send, cleanup } = await mount(adapter, handler);
try {
  await legs(send);
} finally {
  await cleanup();
  await close();
}
process.stdout.write(`ok ${adapter}\n`);
process.exit(0);
