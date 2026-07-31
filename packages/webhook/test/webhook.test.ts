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
import { readFileSync } from 'node:fs';

import { toAmount } from '@pwngh/economy-lab';
import {
  createWebhookVerifier,
  signBody,
  verifySignature,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from '../src/index.js';
import type { WebhookEvent } from '../src/index.js';

const SECRET = 'ba9d1c07e4f8a3b5';
const NOW = 1753574400000;

/** A $5.00 pack at 120 credits to the dollar. */
const PURCHASE = {
  eventId: 'evt_8123',
  userId: 'usr_ada',
  amount: 'CREDIT:600.00',
  source: 'steam',
  sku: 'credits-600',
};

/** A replay store that records every id it was asked to claim. */
function replayStore(seen: string[] = []) {
  const claimed = new Set(seen);
  const asked: string[] = [];
  return {
    asked,
    claim: async (eventId: string) => {
      asked.push(eventId);
      if (claimed.has(eventId)) {
        return { claimed: false };
      }
      claimed.add(eventId);
      return { claimed: true };
    },
  };
}

async function delivery(
  body: unknown,
  overrides: { signature?: string; timestamp?: number | string | null } = {},
): Promise<Request> {
  const raw = new TextEncoder().encode(JSON.stringify(body));
  const signature = overrides.signature ?? (await signBody(raw, SECRET));
  const timestamp = 'timestamp' in overrides ? overrides.timestamp : NOW;
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.set(SIGNATURE_HEADER, signature);
  if (timestamp !== null && timestamp !== undefined) {
    headers.set(TIMESTAMP_HEADER, String(timestamp));
  }
  return new Request('https://api.example.com/webhooks/steam', {
    method: 'POST',
    headers,
    body: raw,
  });
}

function gate(replay?: {
  claim: (id: string) => Promise<{ claimed: boolean }>;
}) {
  return createWebhookVerifier({
    secrets: [SECRET],
    now: () => NOW,
    ...(replay === undefined ? {} : { replay }),
  });
}

test('a correctly signed delivery verifies into a typed purchase', async () => {
  const store = replayStore();
  const result = await gate(store).verify('steam', await delivery(PURCHASE));

  assert.equal(result.status, 'verified');
  assert.ok(result.status === 'verified');
  assert.equal(result.provider, 'steam');
  assert.equal(result.event.eventId, 'evt_8123');
  const purchase = result.event as Extract<WebhookEvent, { userId: string }>;
  assert.equal(purchase.userId, 'usr_ada');
  assert.equal(
    result.event.provider,
    'steam',
    'the provider comes from the route',
  );
  assert.deepEqual(store.asked, ['evt_8123']);
  assert.equal(
    new TextDecoder().decode(result.raw),
    JSON.stringify(PURCHASE),
    'the verified bytes are the bytes that arrived',
  );
});

test('a forged signature refuses, and never reaches the replay store', async () => {
  const store = replayStore();
  const forged = await delivery(PURCHASE, { signature: 'a'.repeat(64) });
  const result = await gate(store).verify('steam', forged);

  assert.ok(result.status === 'refused');
  assert.equal(result.reason, 'signature');
  assert.match(result.message, /signature for 'steam' does not match/);
  assert.deepEqual(store.asked, [], 'a forgery burns no event id');
});

test('an edited body refuses even though its own signature is well formed', async () => {
  const raw = new TextEncoder().encode(JSON.stringify(PURCHASE));
  const signature = await signBody(raw, SECRET);
  const tampered = await delivery(
    { ...PURCHASE, amount: 'CREDIT:60000.00' },
    { signature },
  );

  const result = await gate().verify('steam', tampered);

  assert.ok(result.status === 'refused');
  assert.equal(result.reason, 'signature');
});

test('a stale or missing timestamp is a duplicate, not a fault', async () => {
  const store = replayStore();
  const old = await delivery(PURCHASE, { timestamp: NOW - 6 * 60_000 });
  const stale = await gate(store).verify('steam', old);

  assert.ok(stale.status === 'duplicate');
  assert.equal(stale.reason, 'stale');
  assert.match(stale.message, /300000ms freshness window/);

  const undated = await gate(store).verify(
    'steam',
    await delivery(PURCHASE, { timestamp: null }),
  );
  assert.ok(undated.status === 'duplicate');
  assert.equal(undated.reason, 'stale');

  assert.deepEqual(store.asked, [], 'a stale delivery burns no event id');
});

test('a redelivered event id is a duplicate on its second arrival', async () => {
  const store = replayStore();
  const verifier = gate(store);

  const first = await verifier.verify('steam', await delivery(PURCHASE));
  const second = await verifier.verify('steam', await delivery(PURCHASE));

  assert.equal(first.status, 'verified');
  assert.ok(second.status === 'duplicate');
  assert.equal(second.reason, 'replay');
  assert.match(second.message, /'evt_8123' from 'steam' was accepted already/);
  assert.deepEqual(store.asked, ['evt_8123', 'evt_8123']);
});

test('a signed body the decoder cannot read is malformed, not a forgery', async () => {
  const notJson = new TextEncoder().encode('not json at all');
  const result = await gate().verifyDelivery({
    provider: 'steam',
    raw: notJson,
    signature: await signBody(notJson, SECRET),
    timestamp: NOW,
  });

  assert.ok(result.status === 'refused');
  assert.equal(result.reason, 'malformed');
  assert.match(result.message, /not valid JSON/);

  const missingField = await delivery({
    eventId: 'evt_8124',
    userId: 'usr_ada',
  });
  const short = await gate().verify('steam', missingField);
  assert.ok(short.status === 'refused');
  assert.equal(short.reason, 'malformed');
});

// The doc on `decoders` is the only roster of the default body shape a host reads, so a body
// built from it has to be one the decoder accepts.
test('the default decoder takes the body its own doc describes', async () => {
  const asDocumented = {
    eventId: 'evt_8125',
    userId: 'usr_ada',
    amount: 'CREDIT:600.00',
    sku: 'credits-600',
  };
  const refused = await gate().verify('steam', await delivery(asDocumented));

  assert.ok(refused.status === 'refused');
  assert.equal(refused.reason, 'malformed');
  assert.match(refused.message, /'source'/);

  // One field is the whole difference between that refusal and a delivery the gate takes.
  const whole = await gate().verify(
    'steam',
    await delivery({ ...asDocumented, source: 'steam' }),
  );
  assert.equal(whole.status, 'verified');

  const src = readFileSync(
    new URL('../src/lib/verify.ts', import.meta.url),
    'utf8',
  );
  const doc = /Per-provider body decoders\.[\s\S]*?\*\//.exec(src)?.[0] ?? '';
  assert.ok(doc.length > 0, 'the decoders option still carries a doc');
  for (const field of [
    '`eventId`',
    '`userId`',
    '`amount`',
    '`source`',
    '`sku`',
  ]) {
    assert.ok(
      doc.includes(field),
      `the decoders doc leaves ${field} out of the body it names`,
    );
  }
});

test('a provider decoder replaces the default and still runs behind the gate', async () => {
  const settled = {
    eventId: 'evt_9001',
    payout_id: 'pay_7f2b8c10',
    reference: 'tr_44f1',
  };
  const store = replayStore();
  const verifier = createWebhookVerifier({
    secrets: [SECRET],
    now: () => NOW,
    replay: store,
    decoders: {
      rail: ({ provider, body }) => {
        const row = body as Record<string, string>;
        return {
          kind: 'payoutSettled',
          provider,
          eventId: row.eventId!,
          sagaId: row.payout_id!,
          providerRef: row.reference!,
        };
      },
    },
  });

  const result = await verifier.verify('rail', await delivery(settled));

  assert.ok(result.status === 'verified');
  assert.equal(result.event.kind, 'payoutSettled');
  assert.equal(result.event.eventId, 'evt_9001');
  assert.deepEqual(store.asked, ['evt_9001']);

  const forged = await verifier.verify(
    'rail',
    await delivery(settled, { signature: 'b'.repeat(64) }),
  );
  assert.ok(forged.status === 'refused');
  assert.deepEqual(
    store.asked,
    ['evt_9001'],
    'the decoder did not run on the forgery',
  );
});

test('verifySignature answers no for every unusable signature', async () => {
  const raw = new TextEncoder().encode('{"eventId":"evt_8123"}');
  const good = await signBody(raw, SECRET);

  assert.equal(await verifySignature(raw, good, [SECRET]), true);
  assert.equal(await verifySignature(raw, good, ['another-secret']), false);
  assert.equal(await verifySignature(raw, '', [SECRET]), false);
  assert.equal(await verifySignature(raw, 'not-hex-at-all', [SECRET]), false);
  assert.equal(await verifySignature(raw, good.slice(0, -1), [SECRET]), false);
  assert.equal(
    await verifySignature(raw, `0${good}`.slice(0, 64), [SECRET]),
    false,
  );
});

test('an empty secret is refused at construction', () => {
  assert.throws(
    () => createWebhookVerifier({ secrets: [] }),
    /at least one secret/,
  );
  assert.throws(
    () => createWebhookVerifier({ secrets: [''] }),
    /non-empty string/,
  );
});

// `process.env.WEBHOOK_SECRET` is typed a string and is undefined when the variable is unset,
// which is the case this guard exists for. TextEncoder would turn each of these into a key.
test('an unset secret is refused at construction, whatever shape it arrives in', () => {
  for (const unset of [undefined, null, 0, false]) {
    assert.throws(
      () => createWebhookVerifier({ secrets: [unset as unknown as string] }),
      /non-empty string/,
      `a secret of ${String(unset)} built a verifier`,
    );
    assert.throws(
      () => createWebhookVerifier({ secrets: unset as unknown as string[] }),
      /at least one secret/,
      `a secret list of ${String(unset)} built a verifier`,
    );
  }
});

// Rotation without downtime: the provider still signs with the retired secret for as long as it
// takes them to switch, and both deliveries have to land in that window.
test('a delivery signed with a retired secret still verifies during rotation', async () => {
  const retired = 'ba9d1c07e4f8a3b5';
  const current = '4e1f77b0c2a98d63';
  const raw = new TextEncoder().encode(JSON.stringify(PURCHASE));

  const before = createWebhookVerifier({ secrets: [retired], now: () => NOW });
  const during = createWebhookVerifier({
    secrets: [current, retired],
    now: () => NOW,
  });
  const after = createWebhookVerifier({ secrets: [current], now: () => NOW });

  const oldSignature = await signBody(raw, retired);
  const newSignature = await signBody(raw, current);
  const status = async (
    verifier: ReturnType<typeof createWebhookVerifier>,
    signature: string,
  ) =>
    (
      await verifier.verifyDelivery({
        provider: 'steam',
        raw,
        signature,
        timestamp: NOW,
      })
    ).status;

  assert.equal(await status(before, oldSignature), 'verified');
  assert.equal(await status(before, newSignature), 'refused');

  assert.equal(
    await status(during, oldSignature),
    'verified',
    'the retired secret still verifies',
  );
  assert.equal(
    await status(during, newSignature),
    'verified',
    'and so does the new one',
  );

  assert.equal(
    await status(after, oldSignature),
    'refused',
    'dropping it closes the window',
  );
  assert.equal(await status(after, newSignature), 'verified');
});

test('a freshness window that is not a real duration is refused at construction', () => {
  for (const window of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () =>
        createWebhookVerifier({ secrets: [SECRET], freshnessWindowMs: window }),
      /freshness window/,
      `a window of ${String(window)} built a verifier`,
    );
  }
  assert.ok(createWebhookVerifier({ secrets: [SECRET], freshnessWindowMs: 0 }));
});

test('the freshness window holds at its edge and one millisecond past it', async () => {
  const window = 300_000;
  const verifier = createWebhookVerifier({
    secrets: [SECRET],
    now: () => NOW,
    freshnessWindowMs: window,
  });
  const raw = new TextEncoder().encode(JSON.stringify(PURCHASE));
  const signature = await signBody(raw, SECRET);
  const at = async (timestamp: number) =>
    (
      await verifier.verifyDelivery({
        provider: 'steam',
        raw,
        signature,
        timestamp,
      })
    ).status;

  assert.equal(
    await at(NOW - window),
    'verified',
    'the edge is inside the window',
  );
  assert.equal(
    await at(NOW + window),
    'verified',
    'the edge ahead is inside too',
  );
  assert.equal(await at(NOW - window - 1), 'duplicate');
  assert.equal(await at(NOW + window + 1), 'duplicate');
});

// The window is a bound on clock skew, not on replay: the timestamp rides in a header the
// signature does not cover, so re-dating a captured delivery walks straight back through it.
// The name that said otherwise is gone; what it hid is asserted here instead.
test('a captured delivery re-dated to now verifies again, however old it is', async () => {
  const raw = new TextEncoder().encode(JSON.stringify(PURCHASE));
  const signature = await signBody(raw, SECRET);
  let clock = NOW;
  const verifier = createWebhookVerifier({
    secrets: [SECRET],
    now: () => clock,
  });

  for (let arrival = 1; arrival <= 5; arrival += 1) {
    clock = NOW + arrival * 24 * 60 * 60_000;
    const result = await verifier.verifyDelivery({
      provider: 'steam',
      raw,
      signature,
      timestamp: clock,
    });
    assert.equal(
      result.status,
      'verified',
      `arrival ${arrival}, ${arrival} days on, did not verify`,
    );
  }
});

// So this is the defence, and it is the only one the gate itself has.
test('the replay claim refuses the re-dated delivery the window lets through', async () => {
  const raw = new TextEncoder().encode(JSON.stringify(PURCHASE));
  const signature = await signBody(raw, SECRET);
  let clock = NOW;
  const store = replayStore();
  const verifier = createWebhookVerifier({
    secrets: [SECRET],
    now: () => clock,
    replay: store,
  });
  const arrive = () =>
    verifier.verifyDelivery({
      provider: 'steam',
      raw,
      signature,
      timestamp: clock,
    });

  assert.equal((await arrive()).status, 'verified');
  clock = NOW + 24 * 60 * 60_000;
  const second = await arrive();
  assert.ok(second.status === 'duplicate');
  assert.equal(second.reason, 'replay');
  assert.deepEqual(store.asked, ['evt_8123', 'evt_8123']);
});

// A host reads the names before it reads the doc, so the roster is a contract: a name after replay
// promises a defence the window does not provide.
test('the package publishes exactly this roster, and nothing named after replay', async () => {
  const surface = Object.keys(await import('../src/index.js')).sort();

  assert.deepEqual(surface, [
    'DEFAULT_FRESHNESS_WINDOW_MS',
    'SIGNATURE_HEADER',
    'TIMESTAMP_HEADER',
    'createWebhookVerifier',
    'signBody',
    'verifySignature',
  ]);

  const src = readFileSync(
    new URL('../src/lib/verify.ts', import.meta.url),
    'utf8',
  );
  const block = /export type WebhookVerifierOptions = \{([\s\S]*?)\n\};/.exec(
    src,
  )?.[1];
  assert.ok(block, 'WebhookVerifierOptions is no longer declared here');
  assert.deepEqual(
    [...block!.matchAll(/^ {2}readonly (\w+)\??:/gm)].map((m) => m[1]),
    [
      'secrets',
      'decoders',
      'replay',
      'freshnessWindowMs',
      'maxBodyBytes',
      'readTimeoutMs',
      'meter',
      'now',
    ],
  );
});

test('no decoder runs until the signature and the window have both settled', async () => {
  const raw = new TextEncoder().encode(JSON.stringify(PURCHASE));
  const signature = await signBody(raw, SECRET);
  let decoded = 0;
  const verifier = createWebhookVerifier({
    secrets: [SECRET],
    now: () => NOW,
    decoders: {
      steam: ({ provider }) => {
        decoded += 1;
        return {
          provider,
          eventId: 'evt_8123',
          userId: 'usr_ada',
          amount: toAmount('CREDIT', 60_000n),
          source: 'steam',
        };
      },
    },
  });

  await verifier.verifyDelivery({
    provider: 'steam',
    raw,
    signature: 'a'.repeat(64),
    timestamp: NOW,
  });
  assert.equal(decoded, 0, 'a forged delivery reached the decoder');

  await verifier.verifyDelivery({
    provider: 'steam',
    raw,
    signature,
    timestamp: NOW - 6 * 60_000,
  });
  assert.equal(decoded, 0, 'a stale delivery reached the decoder');

  await verifier.verifyDelivery({
    provider: 'steam',
    raw,
    signature: null,
    timestamp: NOW,
  });
  assert.equal(decoded, 0, 'an unsigned delivery reached the decoder');

  const good = await verifier.verifyDelivery({
    provider: 'steam',
    raw,
    signature,
    timestamp: NOW,
  });
  assert.equal(good.status, 'verified');
  assert.equal(
    decoded,
    1,
    'the decoder ran once, on the delivery that proved itself',
  );
});

// The hex a provider sends is the hex the lab reads: lowercase only, even length, nothing else.
test('fromHex refuses on its own terms, not just by decoding to the wrong bytes', async () => {
  const raw = new TextEncoder().encode(JSON.stringify(PURCHASE));
  const good = await signBody(raw, SECRET);

  assert.match(good, /^[0-9a-f]{64}$/, 'signBody emits lowercase hex');
  assert.equal(await verifySignature(raw, good.toUpperCase(), [SECRET]), false);
  assert.equal(
    await verifySignature(raw, `${good.slice(0, 62)}0g`, [SECRET]),
    false,
  );
  assert.equal(await verifySignature(raw, `${good} `, [SECRET]), false);
  assert.equal(
    await verifySignature(raw, `0x${good.slice(2)}`, [SECRET]),
    false,
  );
});

// A store outage is not a verdict. Answering 'refused' would drop a genuine delivery and
// answering 'verified' would apply it twice, so the failure has to reach the caller.
test('a replay store that is down surfaces instead of becoming an answer', async () => {
  const raw = new TextEncoder().encode(JSON.stringify(PURCHASE));
  const signature = await signBody(raw, SECRET);
  const verifier = createWebhookVerifier({
    secrets: [SECRET],
    now: () => NOW,
    replay: {
      claim: async () => {
        throw new Error('replay store unreachable');
      },
    },
  });

  await assert.rejects(
    () =>
      verifier.verifyDelivery({
        provider: 'steam',
        raw,
        signature,
        timestamp: NOW,
      }),
    /replay store unreachable/,
  );
});
