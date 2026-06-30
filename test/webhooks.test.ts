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
import { settleDuePayouts } from '#src/worker/payouts.ts';
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
  fakeProcessor,
  fixedClock,
  fixedRates,
  noopMeter,
  sequentialIds,
  seededDigest,
  seededSigner,
  testConfig,
  testLogger,
} from '#test/support/capabilities.ts';

import type { Economy } from '#src/economy.ts';
import type { PayoutSettledEvent, WebhookEvent } from '#src/webhooks.ts';
import type { WebhookHandler } from '#src/server.ts';
import type { WorkerCtx } from '#src/contract.ts';
import type { Clock, Ids, Saga, Store } from '#src/ports.ts';

// Signs raw bytes with HMAC-SHA256 under `secret`. Returns the lowercase hex digest the server
// expects in `x-signature`. Uses Web Crypto so the test runs unchanged on every runtime.
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

// Builds a POST to a webhook endpoint with an optional signature and timestamp. Lets a test send a
// correctly-signed, forged, or stale callback.
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

// Builds the wire body a provider POSTs. The money field is a decimal string, encoded with the same
// codec the server decodes.
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

// Builds the id generator and clock the webhook handler uses to mint each inbox row. Fresh per test
// so row ids and `receivedAt` are deterministic. These are independent of the economy's own
// generators because the row only needs some unique id and a timestamp.
function webhookCtx(): { ids: Ids; clock: Clock } {
  return { ids: sequentialIds(), clock: fixedClock(0) };
}

// Builds a worker context from deterministic fakes, with the clock reading `now`. One helper covers
// two callers. drainInbox only reads logger, meter, and config, so it drains at `now: 0`. The submit
// sweep needs the clock past the request-time PENDING SLA to find a RESERVED payout due. The
// generators are independent of the economy's, as a separate worker process would have.
function workerCtxAt(now: number): WorkerCtx {
  return {
    clock: fixedClock(now),
    ids: sequentialIds(),
    digest: seededDigest(1),
    signer: seededSigner(1),
    processor: fakeProcessor(),
    rates: fixedRates(),
    logger: testLogger(),
    meter: noopMeter(),
    config: testConfig(),
  };
}

// Runs one inbox-apply sweep. Claims every pending row and submits its stored Operation through the
// economy, the same path the background worker drives. Mirrors how a real deploy settles a persisted
// webhook off the request path.
function drainOnce(
  store: Store,
  economy: Economy,
): ReturnType<typeof drainInbox> {
  return drainInbox(store, workerCtxAt(0), { economy, now: 0, limit: 10 });
}

describe('Webhooks toTopUp / Idempotency', () => {
  test('derives the topUp idempotency key from the provider eventId', () => {
    let op = toTopUp(SAMPLE);

    assert.equal(op.kind, 'topUp');
    assert.equal(op.idempotencyKey, webhookIdempotencyKey('evt_provider_1'));
    // The idempotency key makes a retry run at most once, because a repeat with the same key is
    // skipped. The `whk:` prefix keeps webhook keys from colliding with keys an ordinary API caller
    // chose.
    assert.equal(op.idempotencyKey, 'whk:evt_provider_1');
  });

  test('copies eventId / sku / provider as origin info onto the posting metadata', () => {
    let op = toTopUp(SAMPLE) as unknown as { meta?: Record<string, unknown> };

    // Origin details (provider, event, item) ride on the operation so the topUp handler can stamp
    // them onto the meta of the ledger posting, giving each created-credits entry a back-pointer to
    // the provider callback that caused it.
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

describe('Webhooks handlePurchaseWebhook (Persist To Inbox, Apply Later)', () => {
  test('persists the topUp instead of posting it inline; the apply sweep credits the buyer', async () => {
    let store = memoryStore();
    let economy = makeEconomy(1, store);

    // The handler enqueues and returns immediately: the balance has not moved yet, decoupling the
    // provider's acknowledgement from the ledger.
    let ack = await handlePurchaseWebhook(store, webhookCtx(), SAMPLE);
    assert.equal(ack.status, 'accepted');
    assert.equal(ack.entry.status, 'pending');
    assert.equal(ack.entry.key, 'evt_provider_1');
    assert.equal(
      encodeAmount(await economy.read.balance(spendable('usr_buyer'))),
      'CREDIT:0.00',
    );

    // The apply worker submits the stored Operation; the credit posts here, not at handler return.
    let summary = await drainOnce(store, economy);
    assert.deepEqual(summary.applied, [ack.entry.id]);
    assert.deepEqual(summary.failed, []);
    assert.equal(
      encodeAmount(await economy.read.balance(spendable('usr_buyer'))),
      'CREDIT:10.00',
    );
  });

  test('a redelivery of the same eventId enqueues nothing new and applies at most once', async () => {
    let store = memoryStore();
    let economy = makeEconomy(1, store);
    // One id generator across both deliveries, as a single serving process has. A real `Ids` mints a
    // globally-unique id each call, so the second delivery's freshly-minted id differs from the row
    // already stored under the key. That difference is how the handler tells a duplicate apart.
    let ctx = webhookCtx();

    let first = await handlePurchaseWebhook(store, ctx, SAMPLE);
    assert.equal(first.status, 'accepted');

    // Same eventId again. The inbox dedupes on it (the row `key`), so no second row is inserted and
    // the existing one is returned as a duplicate. The credit is queued exactly once, however many
    // times the provider redelivers.
    let second = await handlePurchaseWebhook(store, ctx, SAMPLE);
    assert.equal(second.status, 'duplicate');
    assert.equal(second.entry.id, first.entry.id);

    let summary = await drainOnce(store, economy);
    assert.deepEqual(summary.applied, [first.entry.id]);
    assert.equal(
      encodeAmount(await economy.read.balance(spendable('usr_buyer'))),
      'CREDIT:10.00',
    );
  });

  test('re-draining an applied row is a no-op; the operation idempotency key holds exactly-once', async () => {
    let store = memoryStore();
    let economy = makeEconomy(1, store);

    let ack = await handlePurchaseWebhook(store, webhookCtx(), SAMPLE);
    await drainOnce(store, economy);

    // The row is 'applied' and no longer claimed, so a second sweep applies nothing and the balance
    // stays put. Even if a row were re-submitted, the topUp's idempotency key (the provider event id)
    // would dedupe it to the same money move.
    let second = await drainOnce(store, economy);
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.failed, []);
    assert.equal(ack.status, 'accepted');
    assert.equal(
      encodeAmount(await economy.read.balance(spendable('usr_buyer'))),
      'CREDIT:10.00',
    );
  });
});

// Builds a real HTTP server over one shared store. Four collaborators then read and write the same
// ledger: the replay store, which records each eventId on first sight so a redelivery is skipped;
// the inbox the handler persists into; the economy the apply sweep posts through; and the balance
// the assertions check. The store's digest and clock are deterministic (fixed-seed digest, clock
// frozen at 0) for a stable result every run.
function gatedServer(secret: string): {
  server: (request: Request) => Promise<Response>;
  store: Store;
  economy: ReturnType<typeof makeEconomy>;
} {
  let digest = seededDigest(1);
  let clock = fixedClock(0);
  let store = memoryStore({ digest, clock });
  let economy = makeEconomy(1, store);
  let replay = store.replay;
  let ids = sequentialIds();
  let webhook: WebhookHandler = async (provider, request) => {
    let event = decodeWebhookEvent(provider, await request.json());
    // The handler persists the verified callback to the inbox and returns immediately. The apply
    // sweep (`drainInbox`) settles it. The status is 'accepted' on first sight, or 'duplicate'.
    let ack = await handlePurchaseWebhook(store, { ids, clock }, event);
    return new Response(JSON.stringify({ status: ack.status }), {
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
  return { server, store, economy };
}

describe('createServer /webhooks Replay Dedup', () => {
  test('two valid deliveries of the same eventId credit once (second enqueues nothing)', async () => {
    let secret = 'sek_test';
    let { server, store, economy } = gatedServer(secret);
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
      'accepted',
    );

    // The replay store has already claimed the eventId. The redelivery gets a 200 duplicate and the
    // handler never runs, so no second inbox row is enqueued.
    let second = await server(webhookRequest('billing', body, headers));
    assert.equal(second.status, 200);
    assert.equal(
      ((await second.json()) as { status: string }).status,
      'duplicate',
    );

    // The apply sweep settles the one enqueued row, crediting the buyer exactly once.
    await drainOnce(store, economy);
    assert.equal(
      encodeAmount(await economy.read.balance(spendable('usr_buyer'))),
      'CREDIT:10.00',
    );
  });
});

describe('createServer /webhooks Replay Dedup — eventId Consumption & Origin Info', () => {
  test('a forged signature does not consume the eventId (a later valid delivery still credits)', async () => {
    let secret = 'sek_test';
    let { server, store, economy } = gatedServer(secret);
    let body = purchaseBody({
      eventId: 'evt_forge',
      userId: 'usr_buyer',
      amount: '10.00',
    });

    // Forged delivery, signed with the wrong secret. The signature check runs before the replay
    // store records the eventId. A rejected forgery therefore never records the id and cannot block a
    // later genuine delivery of the same id.
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

    // The genuine delivery of that same eventId is recorded for the first time and enqueued. This
    // proves the earlier forgery did not use up the id. Draining the inbox then credits the buyer.
    let valid = await signHex(body, secret);
    let ok = await server(
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
    let secret = 'sek_test';
    let { server, store, economy } = gatedServer(secret);
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
    // Persisted, not posted: the credit posts only after the apply sweep runs.
    await drainOnce(store, economy);
    assert.equal(
      encodeAmount(await economy.read.balance(spendable('usr_buyer'))),
      'CREDIT:25.00',
    );

    // Origin details the posting should carry, built by the same `toTopUp` mapper the handler runs.
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

// Reads back the one open saga for a user. The test can then name it in the settlement webhook
// without depending on the economy's id sequence.
async function onlySagaFor(store: Store, userId: string): Promise<Saga> {
  for await (let saga of store.sagas.list()) {
    if (saga.userId === userId) {
      return saga;
    }
  }
  throw new Error(`no saga for ${userId}`);
}

// Builds a verified payout-settled provider callback for `sagaId`. This is the shape the server edge
// hands to handleWebhook after it has checked the signature and freshness. `providerAmount` is
// recorded for the audit trail only. The posted figures are the rate-derived ones settlePayout
// computes.
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

// Drives a payout from RESERVED to SUBMITTED through the real submit sweep and returns the now-
// SUBMITTED saga. The sweep clock is past the request-time PENDING SLA so the saga is due.
async function submitPayout(store: Store, userId: string): Promise<Saga> {
  let reserved = await onlySagaFor(store, userId);
  assert.equal(reserved.state, 'RESERVED');
  let summary = await settleDuePayouts(store, workerCtxAt(60_000), {
    now: 60_000,
    limit: 10,
  });
  assert.deepEqual(summary.submitted, [reserved.id]);
  let submitted = await onlySagaFor(store, userId);
  assert.equal(submitted.state, 'SUBMITTED');
  return submitted;
}

// Covers the full webhook-driven settlement path, which replaces the old "worker submits then the
// next sweep settles" flow. The worker sweep now only submits a RESERVED payout. The provider's
// "payout settled" callback drives the SUBMITTED -> SETTLED step: the verified event is mapped to a
// settlePayout operation and persisted to the inbox, and drainInbox submits it through the economy.
// The settle outcomes asserted here are the ones the old worker-settle test asserted, unweakened.
describe('Webhooks payout settled (worker submits, the settlement webhook settles)', () => {
  // Drives a real, backed book up to a SUBMITTED payout. A buyer tops up and spends on a listing, so
  // the seller accrues real earned credit. The buyer's custodial credit drops, which lowers the
  // backing requirement. The seller then requests a payout of their whole earned balance, and the
  // worker sweep submits it. Returns the SUBMITTED saga and the reserved amount so the caller can
  // settle it.
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
    // Buyer buys a listing; the whole net (after the platform fee) goes to the seller's earned.
    await economy.submit(
      buildSpend({
        buyerId: 'usr_buyer',
        sku: 'sku_item',
        price: credit('20.00'),
        recipients: [{ sellerId: seller, shareBps: 10_000 }],
      }),
    );
    // Pay out the seller's whole earned balance (no minimum in the test config).
    let reserve = (await economy.read.balance(earned(seller))) as ReturnType<
      typeof credit
    >;
    let reserved = await economy.submit(
      buildRequestPayout({ userId: seller, amount: reserve }),
    );
    assert.equal(reserved.status, 'committed');

    // The worker sweep submits the reserved payout to the provider (RESERVED -> SUBMITTED). It does
    // not settle.
    let saga = await submitPayout(store, seller);
    return { saga, reserve };
  }

  test('a verified payout-settled webhook settles the matching submitted saga', async () => {
    let store = memoryStore({ digest: seededDigest(1), clock: fixedClock(0) });
    let economy = makeEconomy(1, store);
    let seller = 'usr_seller';

    let { saga, reserve } = await bookToSubmitted(store, economy, seller);
    // After submit, the reserve is still escrowed and REVENUE holds only the platform's sale fee. No
    // settle has run.
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
      reserve,
    );
    let revenueBefore = await store.ledger.balance(SYSTEM.REVENUE);
    let trustBefore = await store.ledger.balance(SYSTEM.TRUST_CASH);
    let clearingBefore = await store.ledger.balance(SYSTEM.USD_CLEARING);

    // The provider reports the disbursement settled. The verified callback is mapped to a
    // settlePayout operation and persisted to the inbox. Nothing has settled yet.
    let ack = await handleWebhook(
      store,
      webhookCtx(),
      payoutSettledEvent({ eventId: 'evt_settle_1', sagaId: saga.id }),
    );
    assert.equal(ack.status, 'accepted');
    assert.equal(
      await onlySagaFor(store, seller).then((s) => s.state),
      'SUBMITTED',
    );

    // drainInbox submits the stored settlePayout through the economy: the SUBMITTED -> SETTLED step.
    let drain = await drainOnce(store, economy);
    assert.deepEqual(drain.applied, [ack.entry.id]);
    assert.deepEqual(drain.failed, []);

    // Outcome, carried over from the old worker-settle test and unweakened. The saga is SETTLED. The
    // reserve cleared to REVENUE, so REVENUE rose by exactly the reserve. An equal sum of USD left
    // TRUST_CASH through USD_CLEARING, the reserve converted at the $0.005 payout rate.
    assert.equal(
      await onlySagaFor(store, seller).then((s) => s.state),
      'SETTLED',
    );
    assert.deepEqual(
      await store.ledger.balance(SYSTEM.PAYOUT_RESERVE),
      credit('0.00'),
    );
    let usdMoved = toAmount('USD', (reserve.minor * 5n) / 1000n); // reserve at the $0.005 payout rate
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

    // The books still hold every rule after the webhook-driven settle. Each currency is conserved,
    // and the book is still backed: TRUST_CASH covers the buyer's remaining spendable credits.
    let report = await economy.read.prove();
    assert.equal(report.conserved, true);
    assert.equal(report.backed, true);
  });

  test('a duplicate payout-settled webhook settles the saga exactly once (no double settle)', async () => {
    let store = memoryStore({ digest: seededDigest(1), clock: fixedClock(0) });
    let economy = makeEconomy(1, store);
    let seller = 'usr_seller';
    // One id generator across both deliveries, as a single serving process has. A redelivery then
    // mints a fresh id that differs from the row already stored under the event key.
    let webhook = webhookCtx();

    let { saga } = await bookToSubmitted(store, economy, seller);
    let event = payoutSettledEvent({
      eventId: 'evt_settle_dup',
      sagaId: saga.id,
    });

    // First delivery: enqueued and applied. The saga settles and the reserve clears to REVENUE.
    let first = await handleWebhook(store, webhook, event);
    assert.equal(first.status, 'accepted');
    let firstDrain = await drainOnce(store, economy);
    assert.deepEqual(firstDrain.applied, [first.entry.id]);
    assert.equal(
      await onlySagaFor(store, seller).then((s) => s.state),
      'SETTLED',
    );
    let revenueOnce = await store.ledger.balance(SYSTEM.REVENUE);
    let trustOnce = await store.ledger.balance(SYSTEM.TRUST_CASH);

    // Same eventId again. The inbox dedupes on it (the row key), so no second row is inserted and the
    // existing, already-applied row is returned as a duplicate. Draining claims nothing new.
    let second = await handleWebhook(store, webhook, event);
    assert.equal(second.status, 'duplicate');
    assert.equal(second.entry.id, first.entry.id);
    let secondDrain = await drainOnce(store, economy);
    assert.deepEqual(secondDrain.applied, []);

    // The settle happened exactly once. REVENUE and TRUST_CASH are unchanged from the single settle.
    // The reserve is still empty, not driven negative by a second settle, and the saga stays SETTLED.
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
    let report = await economy.read.prove();
    assert.equal(report.conserved, true);
    assert.equal(report.backed, true);
  });
});
