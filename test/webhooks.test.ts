/// <reference types="node" />
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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '#src/server.ts';
import {
  decodeWebhookEvent,
  handlePurchaseWebhook,
  toTopUp,
  webhookIdempotencyKey,
} from '#src/webhooks.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { encodeAmount } from '#src/money.ts';
import { spendable } from '#src/accounts.ts';
import { toHex } from '#src/bytes.ts';
import { makeEconomy } from '#test/support/economy.ts';
import { credit } from '#test/support/builders.ts';
import {
  fixedClock,
  seededDigest,
  testConfig,
} from '#test/support/capabilities.ts';

import type { WebhookEvent } from '#src/webhooks.ts';
import type { WebhookHandler } from '#src/server.ts';
import type { ReplayStore } from '#src/ports.ts';

// Sign raw bytes with HMAC-SHA256 under `secret`, returning the lowercase hex digest the server
// expects in the `x-signature` header. Web Crypto so the test runs unchanged on every runtime.
async function signHex(body: string, secret: string): Promise<string> {
  let key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  let signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(body),
  );
  return toHex(new Uint8Array(signature));
}

// Build a POST to a webhook endpoint carrying an optional signature/timestamp, so a test can send
// a correctly-signed, forged, or stale callback.
function webhookRequest(
  provider: string,
  body: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(`https://economy.test/webhooks/${provider}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

// The wire body a provider POSTs: the money field travels as a decimal string (the same codec the
// server decodes), exactly as a real client would serialize it.
function purchaseBody(o: {
  eventId: string;
  userId: string;
  amount: string;
  sku?: string;
  source?: string;
}): string {
  return JSON.stringify({
    eventId: o.eventId,
    userId: o.userId,
    amount: encodeAmount(credit(o.amount)),
    source: o.source ?? 'card',
    ...(o.sku === undefined ? {} : { sku: o.sku }),
  });
}

let SAMPLE: WebhookEvent = {
  provider: 'billing',
  eventId: 'evt_provider_1',
  userId: 'usr_buyer',
  amount: credit('10.00'),
  source: 'card',
  sku: 'sku_pack',
};

describe('Webhooks toTopUp / Idempotency', () => {
  test('derives the topUp idempotency key from the provider eventId', () => {
    let op = toTopUp(SAMPLE);

    assert.equal(op.kind, 'topUp');
    assert.equal(op.idempotencyKey, webhookIdempotencyKey('evt_provider_1'));
    // The idempotency key is the value that makes a retried request run at most once: a repeat
    // with the same key is recognized and skipped. Prefixing it with `whk:` keeps the webhook's
    // key from ever colliding with a key an ordinary API caller chose for one of their own
    // operations.
    assert.equal(op.idempotencyKey, 'whk:evt_provider_1');
  });

  test('copies eventId / sku / provider as origin info onto the posting metadata', () => {
    let op = toTopUp(SAMPLE) as unknown as { meta?: Record<string, unknown> };

    // The origin details (which provider, which event, which item) ride on the operation so the
    // topUp handler can stamp them onto the meta of the ledger posting that creates the credits.
    // That gives each created-credits entry a back-pointer to the provider callback that caused it.
    assert.deepEqual(op.meta, {
      eventId: 'evt_provider_1',
      provider: 'billing',
      sku: 'sku_pack',
    });
  });

  test('omits sku from the origin info for a plain credit-pack purchase', () => {
    let op = toTopUp({ ...SAMPLE, sku: undefined }) as unknown as {
      meta?: Record<string, unknown>;
    };

    assert.deepEqual(op.meta, {
      eventId: 'evt_provider_1',
      provider: 'billing',
    });
  });
});

describe('Webhooks decodeWebhookEvent', () => {
  test('round-trips the amount through the decimal-string codec', () => {
    let event = decodeWebhookEvent('billing', {
      eventId: 'evt_1',
      userId: 'usr_x',
      amount: 'CREDIT:12.34',
      source: 'card',
      sku: 'sku_a',
    });

    assert.equal(event.provider, 'billing');
    assert.equal(event.eventId, 'evt_1');
    assert.equal(event.userId, 'usr_x');
    assert.equal(event.source, 'card');
    assert.equal(event.sku, 'sku_a');
    assert.equal(encodeAmount(event.amount), 'CREDIT:12.34');
  });

  test('rejects a non-object body and a missing required field', () => {
    assert.throws(() => decodeWebhookEvent('billing', 42));
    assert.throws(() =>
      decodeWebhookEvent('billing', { eventId: 'e', userId: 'u' }),
    );
  });
});

describe('Webhooks handlePurchaseWebhook (Exactly-Once topUp)', () => {
  test('credits the buyer once; a redelivery of the same eventId posts nothing', async () => {
    let economy = makeEconomy();

    let first = await handlePurchaseWebhook(economy, SAMPLE);
    assert.equal(first.status, 'committed');
    assert.equal(
      encodeAmount(await economy.read.balance(spendable('usr_buyer'))),
      'CREDIT:10.00',
    );

    // Same eventId again: its idempotency key is the same, so the second call is recognized as a
    // duplicate and the balance does not move. The buyer is credited exactly once no matter how
    // many times the provider redelivers the event, with no help needed from the server layer.
    let second = await handlePurchaseWebhook(economy, SAMPLE);
    assert.equal(second.status, 'duplicate');
    assert.equal(
      encodeAmount(await economy.read.balance(spendable('usr_buyer'))),
      'CREDIT:10.00',
    );
  });
});

// Stand up the real HTTP server in front of one shared store, so three things all read and write
// the same ledger: the replay store (which records each eventId the first time it is seen so a
// redelivery can be recognized and skipped), the economy the handler posts into, and the balance
// the assertions check. The store needs a hash function and a clock; here both are deterministic
// (a fixed-seed digest and a clock frozen at time 0) so the test gives the same result every run.
function gatedServer(secret: string): {
  server: (request: Request) => Promise<Response>;
  economy: ReturnType<typeof makeEconomy>;
  replay: ReplayStore;
} {
  let digest = seededDigest(1);
  let clock = fixedClock(0);
  let store = memoryStore({ digest, clock });
  let economy = makeEconomy(1, store);
  let replay = store.replay;
  let webhook: WebhookHandler = async (provider, request) => {
    let event = decodeWebhookEvent(provider, await request.json());
    let outcome = await handlePurchaseWebhook(economy, event);
    return new Response(JSON.stringify({ status: outcome.status }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  let server = createServer(economy, {
    webhook,
    config: { ...testConfig(), webhookSecret: secret },
    clock,
    replay,
  });
  return { server, economy, replay };
}

describe('createServer /webhooks Replay Dedup', () => {
  test('two valid deliveries of the same eventId credit once (second posts nothing)', async () => {
    let secret = 'sek_test';
    let { server, economy } = gatedServer(secret);
    let body = purchaseBody({
      eventId: 'evt_dup',
      userId: 'usr_buyer',
      amount: '10.00',
      sku: 'sku_pack',
    });
    let signature = await signHex(body, secret);
    let headers = { 'x-signature': signature, 'x-timestamp': '0' };

    let first = await server(webhookRequest('billing', body, headers));
    assert.equal(first.status, 200);
    assert.equal(
      ((await first.json()) as { status: string }).status,
      'committed',
    );

    // The replay store has now claimed the eventId; the redelivery is acknowledged 200 duplicate
    // and the handler never runs, so the balance stays put.
    let second = await server(webhookRequest('billing', body, headers));
    assert.equal(second.status, 200);
    assert.equal(
      ((await second.json()) as { status: string }).status,
      'duplicate',
    );

    assert.equal(
      encodeAmount(await economy.read.balance(spendable('usr_buyer'))),
      'CREDIT:10.00',
    );
  });
});

describe('createServer /webhooks Replay Dedup — eventId Consumption & Origin Info', () => {
  test('a forged signature does not consume the eventId (a later valid delivery still credits)', async () => {
    let secret = 'sek_test';
    let { server, economy } = gatedServer(secret);
    let body = purchaseBody({
      eventId: 'evt_forge',
      userId: 'usr_buyer',
      amount: '10.00',
    });

    // A forged delivery: signed with the wrong secret. The signature check runs before the replay
    // store records the eventId, so a rejected forgery never causes the id to be recorded — and
    // therefore can't block a later genuine delivery of that same id from being processed.
    let forged = await signHex(body, 'wrong-secret');
    let rejected = await server(
      webhookRequest('billing', body, {
        'x-signature': forged,
        'x-timestamp': '0',
      }),
    );
    assert.equal(rejected.status, 401);
    assert.equal(
      encodeAmount(await economy.read.balance(spendable('usr_buyer'))),
      'CREDIT:0.00',
    );

    // The genuine delivery of that SAME eventId is recorded for the first time and credits the
    // buyer, proving the earlier forgery did not use up the id.
    let valid = await signHex(body, secret);
    let ok = await server(
      webhookRequest('billing', body, {
        'x-signature': valid,
        'x-timestamp': '0',
      }),
    );
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { status: string }).status, 'committed');
    assert.equal(
      encodeAmount(await economy.read.balance(spendable('usr_buyer'))),
      'CREDIT:10.00',
    );
  });

  test('a verified purchase credits the buyer and carries eventId/sku/provider origin info', async () => {
    let secret = 'sek_test';
    let { server, economy } = gatedServer(secret);
    let body = purchaseBody({
      eventId: 'evt_prov',
      userId: 'usr_buyer',
      amount: '25.00',
      sku: 'sku_hat',
    });
    let signature = await signHex(body, secret);

    let response = await server(
      webhookRequest('billing', body, {
        'x-signature': signature,
        'x-timestamp': '0',
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(
      encodeAmount(await economy.read.balance(spendable('usr_buyer'))),
      'CREDIT:25.00',
    );

    // Check the origin details the posting should carry, built by the same `toTopUp` mapper the
    // handler runs internally.
    let op = toTopUp({
      provider: 'billing',
      eventId: 'evt_prov',
      userId: 'usr_buyer',
      amount: credit('25.00'),
      source: 'card',
      sku: 'sku_hat',
    }) as unknown as { meta?: Record<string, unknown> };
    assert.deepEqual(op.meta, {
      eventId: 'evt_prov',
      provider: 'billing',
      sku: 'sku_hat',
    });
  });
});
