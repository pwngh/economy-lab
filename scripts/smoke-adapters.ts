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

// Live integration smoke for the optional adapters. Drives the Redis cache and the HTTP/SQS
// dispatchers through the REAL wiring (`capabilitiesFromEnv` -> `selectCache`/`selectDispatcher`)
// against running services, with the real drivers (ioredis, @aws-sdk/client-sqs, fetch). The
// fake-based unit tests (test/adapters/*, test/conformance/{cache,dispatcher}.ts) prove each
// adapter's logic; this proves the SDK integration the fakes can't see — it is how the SQS
// command-shape bug was caught (the adapter's `{ input }` command needs wrapping into a real
// `SendMessageCommand`, which only the live SDK rejects).
//
// Each adapter skips when its service is unreachable, so this is safe to run anywhere; it exits
// non-zero only when a reachable adapter actually fails.
//
//   node scripts/smoke-adapters.ts        # or: make smoke
//
// Services (docker compose up -d): Redis :6379, LocalStack/SQS :4566.

import { createServer } from 'node:http';
import { connect } from 'node:net';
import assert from 'node:assert/strict';

import { capabilitiesFromEnv } from '#src/index.ts';
import { encodeEvent } from '#src/adapters/event-wire.ts';
import {
  seededSigner,
  fakeProcessor,
  fixedRates,
  defaultPricing,
} from '#test/support/capabilities.ts';

import type { ExternalPorts } from '#src/index.ts';
import type { EconomyEvent } from '#src/ports.ts';

const ports: ExternalPorts = {
  signer: seededSigner(1),
  processor: fakeProcessor(),
  rates: fixedRates(),
  pricing: defaultPricing(),
};

function sampleEvent(): EconomyEvent {
  return {
    id: 'evt_smoke_1',
    type: 'economy.sale.completed',
    version: 1,
    occurredAt: 0,
    subject: 'usr_smoke',
    data: { amount: '5.00' },
    audience: 'internal',
  };
}

// True if something accepts a TCP connection on host:port within the timeout — used to skip an
// adapter whose service isn't running rather than fail.
function reachable(
  host: string,
  port: number,
  timeoutMs = 600,
): Promise<boolean> {
  return new Promise((resolve) => {
    let socket = connect({ host, port });
    let settle = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

const lines: string[] = [];
function pass(name: string): void {
  lines.push(`  PASS  ${name}`);
}
function skip(name: string): void {
  lines.push(`  SKIP  ${name}`);
}
function failed(name: string, e: unknown): void {
  lines.push(`  FAIL  ${name}: ${e instanceof Error ? e.message : String(e)}`);
}

// --- Redis cache: capabilitiesFromEnv -> selectCache (real ioredis) ---------------
async function smokeRedis(): Promise<void> {
  if (!(await reachable('localhost', 6379))) {
    skip('redis cache (localhost:6379 unreachable)');
    return;
  }
  try {
    let caps = await capabilitiesFromEnv(
      { REDIS_URL: 'redis://localhost:6379' },
      ports,
    );
    let cache = caps.cache!;
    let key = 'smoke:bal:usr_1';
    await cache.set(key, 'CREDIT:9.99');
    assert.equal(await cache.get(key), 'CREDIT:9.99');
    await cache.invalidate(key);
    assert.equal(await cache.get(key), null);
    await caps.store.close();
    pass('redis cache: set / get / invalidate against real Redis');
  } catch (e) {
    failed('redis cache', e);
  }
}

// --- HTTP dispatcher: capabilitiesFromEnv -> selectDispatcher (real fetch) ---------
async function smokeHttp(): Promise<void> {
  let captured: {
    request?: { headers: Record<string, unknown>; body: string };
  } = {};
  let server = createServer((req, res) => {
    let chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      captured.request = {
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      };
      res.writeHead(200);
      res.end('ok');
    });
  });
  try {
    await new Promise<void>((r) => server.listen(0, () => r()));
    let port = (server.address() as { port: number }).port;
    let caps = await capabilitiesFromEnv(
      { DISPATCHER_URL: `http://localhost:${port}/events` },
      ports,
    );
    await caps.dispatcher!(sampleEvent());
    assert.ok(captured.request, 'the receiver got a request');
    assert.equal(captured.request.headers['idempotency-key'], 'evt_smoke_1');
    assert.equal(captured.request.body, encodeEvent(sampleEvent()));
    await caps.store.close();
    pass(
      'http dispatcher: POST body + idempotency-key against a real receiver',
    );
  } catch (e) {
    failed('http dispatcher', e);
  } finally {
    server.close();
  }
}

// --- SQS dispatcher: capabilitiesFromEnv -> selectDispatcher (real LocalStack) -----
async function smokeSqs(): Promise<void> {
  if (!(await reachable('localhost', 4566))) {
    skip('sqs dispatcher (LocalStack localhost:4566 unreachable)');
    return;
  }
  let sqsMod;
  try {
    sqsMod = await import('@aws-sdk/client-sqs');
  } catch {
    skip('sqs dispatcher (@aws-sdk/client-sqs not installed)');
    return;
  }
  // The SDK reads these for the SQSClient selectDispatcher builds; don't clobber a real AWS setup.
  process.env.AWS_ENDPOINT_URL ??= 'http://localhost:4566';
  process.env.AWS_REGION ??= 'us-east-1';
  process.env.AWS_ACCESS_KEY_ID ??= 'test';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
  let {
    SQSClient,
    CreateQueueCommand,
    ReceiveMessageCommand,
    DeleteQueueCommand,
  } = sqsMod;
  let admin = new SQSClient({
    endpoint: 'http://localhost:4566',
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  try {
    let created = await admin.send(
      new CreateQueueCommand({ QueueName: 'economy-smoke' }),
    );
    let queueUrl = created.QueueUrl!;
    let caps = await capabilitiesFromEnv({ SQS_QUEUE_URL: queueUrl }, ports);
    await caps.dispatcher!(sampleEvent());
    let recv = await admin.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 3,
      }),
    );
    assert.equal(recv.Messages?.[0]?.Body, encodeEvent(sampleEvent()));
    await admin.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    await caps.store.close();
    pass(
      'sqs dispatcher: send to LocalStack, received body matches the encoder',
    );
  } catch (e) {
    failed('sqs dispatcher', e);
  } finally {
    admin.destroy();
  }
}

await smokeRedis();
await smokeHttp();
await smokeSqs();

console.warn('=== live adapter smoke (real services) ===');
for (let line of lines) {
  console.warn(line);
}

// Open driver connections (Redis socket, SQS keep-alive) keep the loop alive; exit explicitly.
// eslint-disable-next-line n/no-process-exit
process.exit(lines.some((l) => l.includes('FAIL')) ? 1 : 0);
