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
  handleWebhook,
  toTopUp,
  webhookIdempotencyKey,
} from '#src/webhooks.ts';
import { drainInbox } from '#src/worker/inbox.ts';
import { advanceDuePayouts } from '#src/worker/payouts.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { encodeAmount, toAmount } from '#src/money.ts';
import { earned, spendable, SYSTEM } from '#src/accounts.ts';
import { toHex } from '#src/bytes.ts';
import { makeEconomy } from '#test/support/economy.ts';
import {
  credit,
  requestPayout as buildRequestPayout,
  spend as buildSpend,
  topUp as buildTopUp,
  usd,
} from '#test/support/builders.ts';
import {
  fixedClock,
  makeWorkerCtx,
  sequentialIds,
  seededDigest,
  testConfig,
} from '#test/support/capabilities.ts';

import type { Economy } from '#src/economy.ts';
import type {
  PayoutFailedEvent,
  PayoutSettledEvent,
  WebhookEvent,
} from '#src/webhooks.ts';
import type { WebhookHandler } from '#src/server.ts';
import type { WorkerCtx } from '#src/contract.ts';
import type { Clock, Ids, Saga, Store } from '#src/ports.ts';

// Lowercase hex HMAC-SHA256 over the body — the digest the server expects in `x-signature`.
async function signHex(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(body),
  );
  return toHex(new Uint8Array(signature));
}

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

const SAMPLE: WebhookEvent = {
  provider: 'billing',
  eventId: 'evt_provider_1',
  userId: 'usr_buyer',
  amount: credit('10.00'),
  source: 'card',
  sku: 'sku_pack',
};

function webhookCtx(): { ids: Ids; clock: Clock } {
  return { ids: sequentialIds(), clock: fixedClock(0) };
}

// The submit sweep needs the clock past the request-time PENDING SLA to find a RESERVED payout due.
function workerCtxAt(now: number): WorkerCtx {
  return makeWorkerCtx({ clock: fixedClock(now) });
}

function drainOnce(
  store: Store,
  economy: Economy,
): ReturnType<typeof drainInbox> {
  return drainInbox(store, workerCtxAt(0), { economy, now: 0, limit: 10 });
}

describe('Webhooks toTopUp / Idempotency', () => {
  test('derives the topUp idempotency key from the provider eventId', () => {
    const op = toTopUp(SAMPLE);

    assert.equal(op.kind, 'topUp');
    assert.equal(op.idempotencyKey, webhookIdempotencyKey('evt_provider_1'));
    // The `whk:` prefix keeps webhook keys from colliding with keys an ordinary API caller chose.
    assert.equal(op.idempotencyKey, 'whk:evt_provider_1');
  });

  test('copies eventId / sku / provider as origin info onto the posting metadata', () => {
    const op = toTopUp(SAMPLE) as unknown as { meta?: Record<string, unknown> };

    assert.deepEqual(op.meta, {
      eventId: 'evt_provider_1',
      provider: 'billing',
      sku: 'sku_pack',
    });
  });

  test('omits sku from the origin info for a plain credit-pack purchase', () => {
    const op = toTopUp({ ...SAMPLE, sku: undefined }) as unknown as {
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
    const event = decodeWebhookEvent('billing', {
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

describe('Webhooks handlePurchaseWebhook (Persist To Inbox, Apply Later)', () => {
  test('persists the topUp instead of posting it inline; the apply sweep credits the buyer', async () => {
    const store = memoryStore();
    const economy = makeEconomy(1, store);

    const ack = await handlePurchaseWebhook(store, webhookCtx(), SAMPLE);
    assert.equal(ack.status, 'accepted');
    assert.equal(ack.entry.status, 'pending');
    assert.equal(ack.entry.key, 'evt_provider_1');
    assert.equal(
      encodeAmount(await economy.read.balance(spendable('usr_buyer'))),
      'CREDIT:0.00',
    );

    const summary = await drainOnce(store, economy);
    assert.deepEqual(summary.applied, [ack.entry.id]);
    assert.deepEqual(summary.failed, []);
    assert.equal(
      encodeAmount(await economy.read.balance(spendable('usr_buyer'))),
      'CREDIT:10.00',
    );
  });

  test('a redelivery of the same eventId enqueues nothing new and applies at most once', async () => {
    const store = memoryStore();
    const economy = makeEconomy(1, store);
    // Share one id generator across both deliveries: the handler spots the duplicate because the
    // freshly minted id differs from the row already stored under the key.
    const ctx = webhookCtx();

    const first = await handlePurchaseWebhook(store, ctx, SAMPLE);
    assert.equal(first.status, 'accepted');

    const second = await handlePurchaseWebhook(store, ctx, SAMPLE);
    assert.equal(second.status, 'duplicate');
    assert.equal(second.entry.id, first.entry.id);

    const summary = await drainOnce(store, economy);
    assert.deepEqual(summary.applied, [first.entry.id]);
    assert.equal(
      encodeAmount(await economy.read.balance(spendable('usr_buyer'))),
      'CREDIT:10.00',
    );
  });

  test('re-draining an applied row is a no-op; the operation idempotency key holds exactly-once', async () => {
    const store = memoryStore();
    const economy = makeEconomy(1, store);

    const ack = await handlePurchaseWebhook(store, webhookCtx(), SAMPLE);
    await drainOnce(store, economy);

    const second = await drainOnce(store, economy);
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.failed, []);
    assert.equal(ack.status, 'accepted');
    assert.equal(
      encodeAmount(await economy.read.balance(spendable('usr_buyer'))),
      'CREDIT:10.00',
    );
  });
});

// One shared store wires the replay dedup, the inbox, and the economy the assertions read.
function gatedServer(secret: string): {
  server: (request: Request) => Promise<Response>;
  store: Store;
  economy: ReturnType<typeof makeEconomy>;
} {
  const digest = seededDigest(1);
  const clock = fixedClock(0);
  const store = memoryStore({ digest, clock });
  const economy = makeEconomy(1, store);
  const replay = store.replay;
  const ids = sequentialIds();
  const webhook: WebhookHandler = async (provider, request) => {
    const event = decodeWebhookEvent(provider, await request.json());
    const ack = await handlePurchaseWebhook(store, { ids, clock }, event);
    return new Response(JSON.stringify({ status: ack.status }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const server = createServer(economy, {
    webhook,
    config: { ...testConfig(), webhookSecret: secret },
    clock,
    replay,
  });
  return { server, store, economy };
}

describe('createServer /webhooks Replay Dedup', () => {
  test('two valid deliveries of the same eventId credit once (second enqueues nothing)', async () => {
    const secret = 'sek_test';
    const { server, store, economy } = gatedServer(secret);
    const body = purchaseBody({
      eventId: 'evt_dup',
      userId: 'usr_buyer',
      amount: '10.00',
      sku: 'sku_pack',
    });
    const signature = await signHex(body, secret);
    const headers = { 'x-signature': signature, 'x-timestamp': '0' };

    const first = await server(webhookRequest('billing', body, headers));
    assert.equal(first.status, 200);
    assert.equal(
      ((await first.json()) as { status: string }).status,
      'accepted',
    );

    const second = await server(webhookRequest('billing', body, headers));
    assert.equal(second.status, 200);
    assert.equal(
      ((await second.json()) as { status: string }).status,
      'duplicate',
    );

    await drainOnce(store, economy);
    assert.equal(
      encodeAmount(await economy.read.balance(spendable('usr_buyer'))),
      'CREDIT:10.00',
    );
  });
});

describe('createServer /webhooks Replay Dedup — eventId Consumption & Origin Info', () => {
  test('a forged signature does not consume the eventId (a later valid delivery still credits)', async () => {
    const secret = 'sek_test';
    const { server, store, economy } = gatedServer(secret);
    const body = purchaseBody({
      eventId: 'evt_forge',
      userId: 'usr_buyer',
      amount: '10.00',
    });

    // The signature check runs before the replay store records the eventId, so a rejected forgery
    // cannot consume the id.
    const forged = await signHex(body, 'wrong-secret');
    const rejected = await server(
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

    const valid = await signHex(body, secret);
    const ok = await server(
      webhookRequest('billing', body, {
        'x-signature': valid,
        'x-timestamp': '0',
      }),
    );
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { status: string }).status, 'accepted');
    await drainOnce(store, economy);
    assert.equal(
      encodeAmount(await economy.read.balance(spendable('usr_buyer'))),
      'CREDIT:10.00',
    );
  });

  test('a verified purchase credits the buyer and carries eventId/sku/provider origin info', async () => {
    const secret = 'sek_test';
    const { server, store, economy } = gatedServer(secret);
    const body = purchaseBody({
      eventId: 'evt_prov',
      userId: 'usr_buyer',
      amount: '25.00',
      sku: 'sku_hat',
    });
    const signature = await signHex(body, secret);

    const response = await server(
      webhookRequest('billing', body, {
        'x-signature': signature,
        'x-timestamp': '0',
      }),
    );
    assert.equal(response.status, 200);
    await drainOnce(store, economy);
    assert.equal(
      encodeAmount(await economy.read.balance(spendable('usr_buyer'))),
      'CREDIT:25.00',
    );

    // Origin details the posting should carry, built by the same `toTopUp` mapper the handler runs.
    const op = toTopUp({
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

// Finds the user's one saga, so a test can name it without depending on the id sequence.
async function onlySagaFor(store: Store, userId: string): Promise<Saga> {
  for await (const saga of store.sagas.list()) {
    if (saga.userId === userId) {
      return saga;
    }
  }
  throw new Error(`no saga for ${userId}`);
}

// The shape the server edge hands to handleWebhook after verifying signature and freshness.
// `providerAmount` is audit-trail only; settlePayout posts its own rate-derived figures.
function payoutSettledEvent(o: {
  eventId: string;
  sagaId: string;
}): PayoutSettledEvent {
  return {
    kind: 'payoutSettled',
    provider: 'payouts',
    eventId: o.eventId,
    sagaId: o.sagaId,
    providerRef: `rail_${o.sagaId}`,
    providerAmount: usd('0.02'),
  };
}

async function submitPayout(store: Store, userId: string): Promise<Saga> {
  const reserved = await onlySagaFor(store, userId);
  assert.equal(reserved.state, 'RESERVED');
  const summary = await advanceDuePayouts(store, workerCtxAt(60_000), {
    now: 60_000,
    limit: 10,
  });
  assert.deepEqual(summary.submitted, [reserved.id]);
  const submitted = await onlySagaFor(store, userId);
  assert.equal(submitted.state, 'SUBMITTED');
  return submitted;
}

// Drives a real, backed book up to a SUBMITTED payout; returns the saga and the reserved amount so
// the caller can settle or fail it.
async function bookToSubmitted(
  store: Store,
  economy: Economy,
  seller: string,
): Promise<{ saga: Saga; reserve: ReturnType<typeof credit> }> {
  await economy.submit(
    buildTopUp({
      userId: 'usr_buyer',
      amount: credit('50.00'),
      source: 'card',
    }),
  );
  await economy.submit(
    buildSpend({
      buyerId: 'usr_buyer',
      sku: 'sku_item',
      price: credit('20.00'),
      recipients: [{ sellerId: seller, shareBps: 10_000 }],
    }),
  );
  // Pay out the seller's whole earned balance (no minimum in the test config).
  const reserve = (await economy.read.balance(earned(seller))) as ReturnType<
    typeof credit
  >;
  const reserved = await economy.submit(
    buildRequestPayout({ userId: seller, amount: reserve }),
  );
  assert.equal(reserved.status, 'committed');

  const saga = await submitPayout(store, seller);
  return { saga, reserve };
}

// The worker sweep only submits; the provider's payout-settled callback drives SUBMITTED -> SETTLED.
// The settle outcomes asserted here match the old worker-settle test, unweakened.
describe('Webhooks payout settled (worker submits, the settlement webhook settles)', () => {
  test('a verified payout-settled webhook settles the matching submitted saga', async () => {
    const store = memoryStore({
      digest: seededDigest(1),
      clock: fixedClock(0),
    });
    const economy = makeEconomy(1, store);
    const seller = 'usr_seller';

    const { saga, reserve } = await bookToSubmitted(store, economy, seller);
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
      reserve,
    );
    const revenueBefore = await store.ledger.balance(SYSTEM.REVENUE);
    const trustBefore = await store.ledger.balance(SYSTEM.TRUST_CASH);
    const clearingBefore = await store.ledger.balance(SYSTEM.USD_CLEARING);

    const ack = await handleWebhook(
      store,
      webhookCtx(),
      payoutSettledEvent({ eventId: 'evt_settle_1', sagaId: saga.id }),
    );
    assert.equal(ack.status, 'accepted');
    assert.equal(
      await onlySagaFor(store, seller).then((s) => s.state),
      'SUBMITTED',
    );

    const drain = await drainOnce(store, economy);
    assert.deepEqual(drain.applied, [ack.entry.id]);
    assert.deepEqual(drain.failed, []);

    assert.equal(
      await onlySagaFor(store, seller).then((s) => s.state),
      'SETTLED',
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
      credit('0.00'),
    );
    const usdMoved = toAmount('USD', (reserve.minor * 5n) / 1000n); // reserve at the $0.005 payout rate
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.REVENUE),
      toAmount('CREDIT', revenueBefore.minor + reserve.minor),
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.USD_CLEARING),
      toAmount('USD', clearingBefore.minor + usdMoved.minor),
    );
    // TRUST_CASH (debit-normal, grows on a debit) dropped by exactly the USD that left.
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.TRUST_CASH),
      toAmount('USD', trustBefore.minor - usdMoved.minor),
    );

    const report = await economy.read.prove();
    assert.equal(report.conserved, true);
    assert.equal(report.backed, true);
  });

  test('a duplicate payout-settled webhook settles the saga exactly once (no double settle)', async () => {
    const store = memoryStore({
      digest: seededDigest(1),
      clock: fixedClock(0),
    });
    const economy = makeEconomy(1, store);
    const seller = 'usr_seller';
    const webhook = webhookCtx();

    const { saga } = await bookToSubmitted(store, economy, seller);
    const event = payoutSettledEvent({
      eventId: 'evt_settle_dup',
      sagaId: saga.id,
    });

    const first = await handleWebhook(store, webhook, event);
    assert.equal(first.status, 'accepted');
    const firstDrain = await drainOnce(store, economy);
    assert.deepEqual(firstDrain.applied, [first.entry.id]);
    assert.equal(
      await onlySagaFor(store, seller).then((s) => s.state),
      'SETTLED',
    );
    const revenueOnce = await store.ledger.balance(SYSTEM.REVENUE);
    const trustOnce = await store.ledger.balance(SYSTEM.TRUST_CASH);

    const second = await handleWebhook(store, webhook, event);
    assert.equal(second.status, 'duplicate');
    assert.equal(second.entry.id, first.entry.id);
    const secondDrain = await drainOnce(store, economy);
    assert.deepEqual(secondDrain.applied, []);

    assert.deepEqual(await store.ledger.balance(SYSTEM.REVENUE), revenueOnce);
    assert.deepEqual(await store.ledger.balance(SYSTEM.TRUST_CASH), trustOnce);
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
      credit('0.00'),
    );
    assert.equal(
      await onlySagaFor(store, seller).then((s) => s.state),
      'SETTLED',
    );
    const report = await economy.read.prove();
    assert.equal(report.conserved, true);
    assert.equal(report.backed, true);
  });
});

function payoutFailedEvent(o: {
  eventId: string;
  sagaId: string;
  reason?: string;
}): PayoutFailedEvent {
  return {
    kind: 'payoutFailed',
    provider: 'payouts',
    eventId: o.eventId,
    sagaId: o.sagaId,
    userId: 'usr_seller',
    providerRef: `rail_${o.sagaId}`,
    ...(o.reason === undefined ? {} : { reason: o.reason }),
  };
}

// The payout-failed callback maps to a reversePayout carrying providerReported, which waives the
// maxPayoutAgeMs gate a manual reverse would hit.
describe('Webhooks payout failed (the failure webhook promptly returns the reserve)', () => {
  test('a verified payout-failed webhook reverses a live submitted saga', async () => {
    const store = memoryStore({
      digest: seededDigest(1),
      clock: fixedClock(0),
    });
    const economy = makeEconomy(1, store);
    const seller = 'usr_seller';

    const { saga, reserve } = await bookToSubmitted(store, economy, seller);
    const earnedBefore = await store.ledger.balance(earned(seller));
    const trustBefore = await store.ledger.balance(SYSTEM.TRUST_CASH);

    const ack = await handleWebhook(
      store,
      webhookCtx(),
      payoutFailedEvent({
        eventId: 'evt_fail_1',
        sagaId: saga.id,
        reason: 'beneficiary rejected',
      }),
    );
    assert.equal(ack.status, 'accepted');
    assert.equal(
      await onlySagaFor(store, seller).then((s) => s.state),
      'SUBMITTED',
    );

    const drain = await drainOnce(store, economy);
    assert.deepEqual(drain.applied, [ack.entry.id]);
    assert.deepEqual(drain.failed, []);

    assert.equal(
      await onlySagaFor(store, seller).then((s) => s.state),
      'FAILED',
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
      credit('0.00'),
    );
    assert.deepEqual(
      await store.ledger.balance(earned(seller)),
      toAmount('CREDIT', earnedBefore.minor + reserve.minor),
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.TRUST_CASH),
      trustBefore,
    );

    const report = await economy.read.prove();
    assert.equal(report.conserved, true);
    assert.equal(report.backed, true);
  });

  test('a duplicate payout-failed webhook returns the reserve exactly once', async () => {
    const store = memoryStore({
      digest: seededDigest(1),
      clock: fixedClock(0),
    });
    const economy = makeEconomy(1, store);
    const seller = 'usr_seller';
    const webhook = webhookCtx();

    const { saga } = await bookToSubmitted(store, economy, seller);
    const event = payoutFailedEvent({
      eventId: 'evt_fail_dup',
      sagaId: saga.id,
    });

    const first = await handleWebhook(store, webhook, event);
    assert.equal(first.status, 'accepted');
    await drainOnce(store, economy);
    const earnedOnce = await store.ledger.balance(earned(seller));

    const second = await handleWebhook(store, webhook, event);
    assert.equal(second.status, 'duplicate');
    assert.equal(second.entry.id, first.entry.id);
    const secondDrain = await drainOnce(store, economy);
    assert.deepEqual(secondDrain.applied, []);
    assert.deepEqual(await store.ledger.balance(earned(seller)), earnedOnce);
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
      credit('0.00'),
    );
  });
});
