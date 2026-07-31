/**
 * @pwngh/economy-webhook
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

import { createServer } from '@pwngh/economy-lab/server';
import { createEconomy, memoryPorts } from '@pwngh/economy-lab';

import {
  createWebhookVerifier,
  signBody,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from '../src/index.js';

const SECRET = 'ba9d1c07e4f8a3b5';
const NOW = 1753574400000;
const WINDOW = 300_000;

const PURCHASE = {
  eventId: 'evt_8123',
  userId: 'usr_ada',
  amount: 'CREDIT:600.00',
  source: 'steam',
};

/** One word for what a gate did with a delivery, so the two implementations are comparable. */
type Verdict =
  | 'verified'
  | 'refused:signature'
  | 'refused:malformed'
  | 'duplicate';

// The lab's real route, over a real economy. Its webhook handler only records that it ran: the
// question here is which deliveries reach it, not what it does with them.
function labGate(): (
  raw: Uint8Array,
  signature: string | null,
  timestamp: string | null,
) => Promise<Verdict> {
  const ports = memoryPorts({
    signingKey: '00'.repeat(32),
    secrets: { webhookSecret: SECRET },
    config: { freshnessWindowMs: WINDOW },
  });
  let reached = false;
  const handler = createServer({
    economy: createEconomy(ports),
    ports: {
      config: ports.config,
      secrets: ports.secrets,
      clock: { now: () => NOW },
      meter: ports.meter,
      logger: ports.logger,
      rates: ports.rates,
    },
    authenticate: false,
    webhook: async () => {
      reached = true;
      return new Response(null, { status: 200 });
    },
  });

  return async (raw, signature, timestamp) => {
    reached = false;
    const headers = new Headers();
    if (signature !== null) {
      headers.set(SIGNATURE_HEADER, signature);
    }
    if (timestamp !== null) {
      headers.set(TIMESTAMP_HEADER, timestamp);
    }
    const response = await handler(
      new Request('https://economy.test/webhooks/steam', {
        method: 'POST',
        headers,
        body: raw as unknown as BodyInit,
      }),
    );
    if (response.status === 401) {
      return 'refused:signature';
    }
    if (response.status === 400) {
      return 'refused:malformed';
    }
    return reached ? 'verified' : 'duplicate';
  };
}

function packageGate(): (
  raw: Uint8Array,
  signature: string | null,
  timestamp: string | null,
) => Promise<Verdict> {
  const gate = createWebhookVerifier({
    secrets: [SECRET],
    now: () => NOW,
    freshnessWindowMs: WINDOW,
  });
  return async (raw, signature, timestamp) => {
    const result = await gate.verifyDelivery({
      provider: 'steam',
      raw: raw as Uint8Array<ArrayBuffer>,
      signature,
      timestamp,
    });
    return result.status === 'verified'
      ? 'verified'
      : result.status === 'duplicate'
        ? 'duplicate'
        : (`refused:${result.reason}` as Verdict);
  };
}

const body = new TextEncoder().encode(
  JSON.stringify(PURCHASE),
) as Uint8Array<ArrayBuffer>;

test('both gates answer the same on every signature a delivery can carry', async () => {
  const lab = labGate();
  const own = packageGate();
  const good = await signBody(body, SECRET);
  const wrongSecret = await signBody(body, 'a-different-secret');
  const ts = String(NOW);

  const signatures: Array<[string, string | null]> = [
    ['the real one', good],
    ['the same hex uppercased', good.toUpperCase()],
    [
      'the same hex half uppercased',
      good.slice(0, 32) + good.slice(32).toUpperCase(),
    ],
    ['a forgery of the right length', 'a'.repeat(64)],
    ['one byte short', good.slice(0, -2)],
    ['one hex digit short', good.slice(0, -1)],
    [
      'one digit changed',
      `${good.slice(0, 63)}${good.at(-1) === '0' ? '1' : '0'}`,
    ],
    ['not hex at all', 'zz'.repeat(32)],
    ['empty', ''],
    ['absent', null],
    ['signed with another secret', wrongSecret],
  ];

  for (const [label, signature] of signatures) {
    assert.equal(
      await own(body, signature, ts),
      await lab(body, signature, ts),
      `the two gates disagree on a signature that is ${label}`,
    );
  }
});

test('both gates answer the same on every timestamp a delivery can carry', async () => {
  const lab = labGate();
  const own = packageGate();
  const good = await signBody(body, SECRET);

  const timestamps: Array<[string, string | null]> = [
    ['now', String(NOW)],
    ['exactly one window old', String(NOW - WINDOW)],
    ['one millisecond past the window', String(NOW - WINDOW - 1)],
    ['exactly one window ahead', String(NOW + WINDOW)],
    ['one millisecond past the window ahead', String(NOW + WINDOW + 1)],
    ['absent', null],
    ['empty', ''],
    ['a word', 'yesterday'],
    ['hexadecimal', '0x64'],
    ['padded with spaces', `  ${NOW}  `],
    ['infinite', 'Infinity'],
    ['the epoch', '0'],
  ];

  for (const [label, timestamp] of timestamps) {
    assert.equal(
      await own(body, good, timestamp),
      await lab(body, good, timestamp),
      `the two gates disagree on a timestamp that is ${label}`,
    );
  }
});

test('both gates refuse a body edited by one byte under its original signature', async () => {
  const lab = labGate();
  const own = packageGate();
  const signature = await signBody(body, SECRET);
  const edited = new Uint8Array(body) as Uint8Array<ArrayBuffer>;
  edited[edited.length - 2] = (edited[edited.length - 2]! + 1) % 256;

  assert.equal(await own(edited, signature, String(NOW)), 'refused:signature');
  assert.equal(await lab(edited, signature, String(NOW)), 'refused:signature');
});

test('the two headers this package names are the two the lab reads', async () => {
  const lab = labGate();
  const good = await signBody(body, SECRET);

  assert.equal(SIGNATURE_HEADER, 'x-signature');
  assert.equal(TIMESTAMP_HEADER, 'x-timestamp');
  // Proof rather than assertion: a delivery whose headers came from these constants verifies.
  assert.equal(await lab(body, good, String(NOW)), 'verified');
});

// The replay-storm runbook and the ops detector both read this counter by name. A host that
// swaps the lab's route for this gate keeps the signal only if the gate still emits it.
test('both gates count a duplicate under the same name and tags', async () => {
  const counted: Array<[string, number, Record<string, string> | undefined]> =
    [];
  const meter = {
    count: (name: string, value: number, tags?: Record<string, string>) => {
      counted.push([name, value, tags]);
    },
    observe: () => {},
  };

  const labPorts = memoryPorts({
    signingKey: '00'.repeat(32),
    secrets: { webhookSecret: SECRET },
    config: { freshnessWindowMs: WINDOW },
  });
  const seen = new Set<string>();
  const replay = {
    claim: async (eventId: string) => {
      const claimed = !seen.has(eventId);
      seen.add(eventId);
      return { claimed };
    },
  };
  const labHandler = createServer({
    economy: createEconomy(labPorts),
    ports: {
      config: labPorts.config,
      secrets: labPorts.secrets,
      clock: { now: () => NOW },
      meter,
      logger: labPorts.logger,
      rates: labPorts.rates,
    },
    authenticate: false,
    replay,
    webhook: async () => new Response(null, { status: 200 }),
  });

  const good = await signBody(body, SECRET);
  const deliver = (timestamp: string) =>
    labHandler(
      new Request('https://economy.test/webhooks/steam', {
        method: 'POST',
        headers: new Headers({
          [SIGNATURE_HEADER]: good,
          [TIMESTAMP_HEADER]: timestamp,
        }),
        body: body as unknown as BodyInit,
      }),
    );
  await deliver(String(NOW));
  await deliver(String(NOW));
  await deliver(String(NOW - WINDOW - 1));
  const fromLab = [...counted];
  counted.length = 0;

  const ownSeen = new Set<string>();
  const own = createWebhookVerifier({
    secrets: [SECRET],
    now: () => NOW,
    freshnessWindowMs: WINDOW,
    meter,
    replay: {
      claim: async (eventId: string) => {
        const claimed = !ownSeen.has(eventId);
        ownSeen.add(eventId);
        return { claimed };
      },
    },
  });
  const check = (timestamp: number) =>
    own.verifyDelivery({
      provider: 'steam',
      raw: body,
      signature: good,
      timestamp,
    });
  await check(NOW);
  await check(NOW);
  await check(NOW - WINDOW - 1);

  assert.deepEqual(fromLab, [
    ['economy.webhook.duplicate', 1, { provider: 'steam', layer: 'replay' }],
    ['economy.webhook.duplicate', 1, { provider: 'steam', layer: 'stale' }],
  ]);
  assert.deepEqual(counted, fromLab, 'the gates report the same duplicates');
});
