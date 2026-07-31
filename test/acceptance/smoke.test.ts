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

/**
 * The live integration smoke for the optional adapters: the real wiring, against running services,
 * with the real drivers (ioredis, @aws-sdk/client-sqs, fetch). That is the SDK integration the
 * fake-based unit tests cannot see.
 *
 * It was a script that printed PASS and SKIP lines and exited on whether any line said FAIL, and
 * the probe deciding those skips read a port the adapter never connects to — `localhost:6379` while
 * the wiring used the compose port 56379 — so on a machine with all four rigs up, two of its three
 * legs skipped while naming the port they had not looked at. Run against the right ports, both of
 * those legs failed outright: they called `openPorts({ REDIS_URL }, …)` and `openPorts({
 * SQS_QUEUE_URL }, …)` and expected a driver to be loaded from the URL. `openPorts` reads a URL to
 * decide what it is *missing* and never to import one, so each threw `no cache/dispatcher was
 * supplied`. The wrong port is what kept that from being visible.
 *
 * So each leg now passes the adapter the refusal names, which is the wiring a host writes, and the
 * skips are the runner's — counted with every other skip in the tree. The probe reads its endpoint
 * out of the URL the leg is about to use, so the two cannot name different ports again.
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/storage/ Storage} for the adapter
 * wiring this exercises.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import '#test/support/dist-guard.ts';

import { redisCache } from '@pwngh/economy-redis';
import { sqs } from '@pwngh/economy-sqs';

import { openPorts } from '#src/index.ts';
import { encodeEvent } from '#src/adapters/event-wire.ts';
import {
  seededSigner,
  fakeProcessor,
  fixedRates,
  defaultPricing,
} from '#test/support/capabilities.ts';
import { reachable } from '#test/acceptance/harness.ts';

import type { PortsInit } from '#src/index.ts';
import type { EconomyEvent } from '#src/ports.ts';

const ports: PortsInit = {
  signer: seededSigner(1),
  processor: fakeProcessor(),
  rates: fixedRates(),
  pricing: defaultPricing(),
};

/** The compose stack's own host ports, which sit off the well-known defaults on purpose. */
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:56379';
const SQS_ENDPOINT = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:54566';

/** How long a service gets to accept a connection before this run calls it absent. */
const PROBE_MS = 1_000;

/** The queue this run creates and deletes. */
const QUEUE = 'economy-smoke';

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

/**
 * The endpoint a URL names, so the probe and the wiring cannot disagree about which service is
 * being asked for.
 */
function endpointOf(url: string): { host: string; port: number } {
  const parsed = new URL(url);
  const scheme = parsed.protocol.replace(':', '');
  const fallback = scheme === 'https' ? 443 : scheme === 'http' ? 80 : 6379;
  return {
    host: parsed.hostname,
    port: parsed.port === '' ? fallback : Number(parsed.port),
  };
}

/** Null when the service answered, or the reason a leg is skipping. */
async function absent(url: string, what: string): Promise<string | null> {
  const { host, port } = endpointOf(url);
  return (await reachable(host, port, PROBE_MS))
    ? null
    : `${what} at ${host}:${port} is unreachable — npm run docker`;
}

/** Every leg this file declares, so the reconciliation below reads a roster rather than a count. */
const LEGS = ['redis cache', 'http dispatcher', 'sqs dispatcher'] as const;
const reported: string[] = [];

// The gate on the bug that hid two dead legs for as long as nobody looked. A skip is not a failure,
// so a probe reading the wrong port is invisible in every count this repository keeps — the only
// thing that can catch it is an assertion that the probe resolves the endpoint out of the URL the
// leg is about to use, shown answering both ways on this run.
test('the endpoint a leg probes is the one its own URL names', async () => {
  assert.deepEqual(endpointOf('redis://localhost:56379'), {
    host: 'localhost',
    port: 56379,
  });
  assert.deepEqual(endpointOf('http://localhost:54566'), {
    host: 'localhost',
    port: 54566,
  });
  // A scheme with no port falls back to that scheme's own default, never to another service's.
  assert.deepEqual(endpointOf('redis://cache.internal'), {
    host: 'cache.internal',
    port: 6379,
  });
  assert.deepEqual(endpointOf('https://sqs.example.com'), {
    host: 'sqs.example.com',
    port: 443,
  });

  // The other way: a port nothing listens on is reported absent, naming what was asked for.
  const reason = await absent('redis://127.0.0.1:1', 'redis');
  assert.match(
    reason ?? '',
    /^redis at 127\.0\.0\.1:1 is unreachable/,
    'the probe called a closed port reachable',
  );
});

test('redis cache: set, get and invalidate against real Redis', async (t) => {
  reported.push('redis cache');
  const missing = await absent(REDIS_URL, 'redis');
  if (missing !== null) {
    t.skip(missing);
    return;
  }
  // The URL names the cache and the host supplies it: `openPorts` loads no driver by scheme, so
  // the env alone is a refusal, not a wiring.
  const caps = await openPorts(
    { REDIS_URL },
    { ...ports, cache: await redisCache(REDIS_URL) },
  );
  try {
    const cache = caps.cache;
    assert.ok(cache, 'openPorts dropped the cache it was handed');
    const key = 'smoke:bal:usr_1';
    await cache.set(key, 'CREDIT:9.99');
    assert.equal(await cache.get(key), 'CREDIT:9.99');
    await cache.invalidate(key);
    assert.equal(await cache.get(key), null);
  } finally {
    // The redis connection is this call's own, and nothing else ends it: an open socket keeps the
    // runner's event loop alive, which is a hang rather than a failure.
    await caps.cache?.close?.();
    await caps.store.close();
  }
});

test('http dispatcher: POST body and idempotency-key against a real receiver', async () => {
  reported.push('http dispatcher');
  const captured: {
    request?: { headers: Record<string, unknown>; body: string };
  } = {};
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
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
    const port = (server.address() as { port: number }).port;
    const caps = await openPorts(
      { DISPATCHER_URL: `http://localhost:${port}/events` },
      ports,
    );
    try {
      await caps.dispatcher!(sampleEvent());
      assert.ok(captured.request, 'the receiver got a request');
      assert.equal(captured.request.headers['idempotency-key'], 'evt_smoke_1');
      assert.equal(captured.request.body, encodeEvent(sampleEvent()));
    } finally {
      await caps.dispatcher?.close?.();
      await caps.store.close();
    }
  } finally {
    server.close();
  }
});

test('sqs dispatcher: the received body matches the encoder', async (t) => {
  reported.push('sqs dispatcher');
  const missing = await absent(SQS_ENDPOINT, 'localstack');
  if (missing !== null) {
    t.skip(missing);
    return;
  }
  let sqsMod;
  try {
    sqsMod = await import('@aws-sdk/client-sqs');
  } catch {
    t.skip('@aws-sdk/client-sqs is not installed');
    return;
  }
  // The SDK reads these when selectDispatcher builds its SQSClient. Filling only the blanks
  // leaves a real AWS setup in the environment untouched.
  process.env.AWS_ENDPOINT_URL ??= SQS_ENDPOINT;
  process.env.AWS_REGION ??= 'us-east-1';
  process.env.AWS_ACCESS_KEY_ID ??= 'test';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
  const {
    SQSClient,
    CreateQueueCommand,
    ReceiveMessageCommand,
    DeleteQueueCommand,
  } = sqsMod;
  const admin = new SQSClient({
    endpoint: SQS_ENDPOINT,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  let queueUrl: string | undefined;
  try {
    const created = (
      await admin.send(new CreateQueueCommand({ QueueName: QUEUE }))
    ).QueueUrl;
    assert.ok(created, 'localstack created no queue');
    // LocalStack hands back a queue URL on `sqs.<region>.localhost.localstack.cloud:4566`, the
    // container's own port, and the SDK treats a queue URL as the endpoint unless told otherwise.
    // The compose stack publishes 54566, so the host is swapped for the one this run can reach —
    // the account and queue path are the queue's identity and are kept exactly.
    queueUrl = new URL(new URL(created).pathname, SQS_ENDPOINT).toString();
    // `sqs()` opens its own SDK client and takes no endpoint, so the endpoint reaches it through
    // AWS_ENDPOINT_URL above — which is why that assignment happens before this line, not after.
    const caps = await openPorts(
      { SQS_QUEUE_URL: queueUrl },
      { ...ports, dispatcher: await sqs({ queueUrl, region: 'us-east-1' }) },
    );
    try {
      assert.ok(caps.dispatcher, 'openPorts dropped the dispatcher');
      await caps.dispatcher(sampleEvent());
      const received = await admin.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 3,
        }),
      );
      assert.equal(received.Messages?.[0]?.Body, encodeEvent(sampleEvent()));
    } finally {
      await caps.dispatcher?.close?.();
      await caps.store.close();
    }
  } finally {
    if (queueUrl) {
      await admin
        .send(new DeleteQueueCommand({ QueueUrl: queueUrl }))
        .catch(() => {});
    }
    admin.destroy();
  }
});

// Declared last, so it reads what the legs above reported rather than what they were meant to.
// The script this replaced decided its own exit code from its own printed lines, so a leg that
// stopped registering at all took its evidence with it and nothing said so.
test('every declared leg reported', () => {
  assert.deepEqual([...reported].sort(), [...LEGS].sort());
  assert.equal(LEGS.length, 3, 'the adapter roster changed size');
});
