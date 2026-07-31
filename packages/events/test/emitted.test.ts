/**
 * @pwngh/economy-events
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

import {
  createEconomy,
  createWorker,
  decodeAmountWire,
  encodeAmount,
  memoryPorts,
  spendable,
  toAmount,
} from '@pwngh/economy-lab';
import { openInstanceEconomies } from '@pwngh/economy-lab/netting';

import { EVENT_TYPES, EVENT_VERSION, narrowEvent } from '../src/index.js';
import type { KnownEvent } from '../src/index.js';

import type { Ports } from '@pwngh/economy-lab';

/**
 * Every type this file has actually read out of an outbox. The last test compares it against the
 * roster, so a declared `data` shape that no scenario produces is a failure rather than a silence:
 * the exported types are this package's whole product, and TypeScript checks them only against the
 * file that declares them.
 */
const SEEN = new Set<KnownEvent['type']>();

// Wide enough that the risk gates never stand between a test and the event it is here to read.
const ROOMY = {
  velocityLimitMinor: 10_000_000_000n,
  payoutMinimumEarnedMinor: 10_000n,
};

function labPorts(config: Record<string, unknown> = {}): Ports {
  return memoryPorts({
    signingKey: '00'.repeat(32),
    config: { ...ROOMY, ...config },
  });
}

// The outbox is where every emitter queues, so it is the one place all of them can be read the
// way a consumer reads them: as parsed JSON, not as the in-process object.
async function drain(ports: Ports): Promise<KnownEvent[]> {
  const rows = await ports.store.transaction((unit) =>
    unit.outbox.claimBatch(100),
  );
  await ports.store.transaction((unit) =>
    unit.outbox.markRelayed(rows.map((row) => row.id)),
  );
  return rows.map((row) => {
    const event = narrowEvent(JSON.parse(JSON.stringify(row.event)));
    assert.ok(
      event !== null,
      `an emitted event did not narrow: ${row.event.type}`,
    );
    assert.equal(
      event.version,
      EVENT_VERSION,
      `${event.type} stamps another version`,
    );
    SEEN.add(event.type);
    return event;
  });
}

/**
 * A drain whose events are about to be read. Every check in {@link drain} sits inside a `.map`, so
 * an empty batch satisfies all of them and a scenario that emitted nothing is indistinguishable
 * from one that emitted correctly. This is the only door the reading tests use.
 */
async function emitted(ports: Ports): Promise<KnownEvent[]> {
  const events = await drain(ports);
  assert.ok(events.length > 0, 'the drain claimed no events at all');
  return events;
}

/**
 * A drain that clears the queue between steps, where the events are setup rather than the subject.
 * The count is stated at every call site, so an extra emit or a missing one is a failure here too.
 */
async function cleared(ports: Ports, expected: number): Promise<void> {
  const events = await drain(ports);
  assert.equal(
    events.length,
    expected,
    `cleared ${events.length} events, expected ${expected}: ${events
      .map((event) => event.type)
      .join(', ')}`,
  );
}

function only<T extends KnownEvent['type']>(
  events: KnownEvent[],
  type: T,
): Extract<KnownEvent, { type: T }> {
  const found = events.filter((event) => event.type === type);
  assert.equal(
    found.length,
    1,
    `expected exactly one ${type}, saw ${found.length}`,
  );
  return found[0] as Extract<KnownEvent, { type: T }>;
}

test('the submit pipeline emits the data these types declare', async () => {
  const ports = labPorts();
  const economy = createEconomy(ports);

  await economy.submit({
    kind: 'topUp',
    idempotencyKey: 'i1',
    actor: { kind: 'system', service: 'test' },
    userId: 'usr_ada',
    source: 'card',
    amount: decodeAmountWire('CREDIT:30000.00'),
  });
  await economy.submit({
    kind: 'spend',
    idempotencyKey: 'i2',
    actor: { kind: 'user', userId: 'usr_ada' },
    orderId: 'ord_1',
    buyerId: 'usr_ada',
    giftTo: 'usr_ben',
    sku: 'sku_hat',
    price: decodeAmountWire('CREDIT:25000.00'),
    recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
  });
  await economy.submit({
    kind: 'requestPayout',
    idempotencyKey: 'i3',
    actor: { kind: 'user', userId: 'usr_seller' },
    userId: 'usr_seller',
    amount: decodeAmountWire('CREDIT:20000.00'),
  });

  const events = await emitted(ports);

  const topUp = only(events, 'economy.credits.topped_up');
  assert.deepEqual(Object.keys(topUp.data), ['txnId']);
  assert.match(topUp.data.txnId, /^txn_/);

  const sale = only(events, 'economy.sale.completed');
  assert.deepEqual(Object.keys(sale.data).sort(), [
    'giftTo',
    'isGift',
    'txnId',
  ]);
  assert.equal(sale.data.isGift, true);
  assert.equal(sale.data.giftTo, 'usr_ben');

  const payout = only(events, 'economy.payout.requested');
  assert.deepEqual(Object.keys(payout.data).sort(), [
    'amount',
    'txnId',
    'userId',
  ]);
  assert.equal(payout.data.userId, 'usr_seller');
  assert.equal(payout.data.amount, 'CREDIT:20000.00');
});

// Two emitters queue this one type: the worker when it gives up on a cash-out, and the operator
// operation. A consumer switching on the type reads whichever arrives, so they must agree.
test('both payout reversals carry the same fields', async () => {
  const withWorker = labPorts({ maxPayoutAgeMs: 0 });
  const workerEconomy = createEconomy(withWorker);
  await fundAPayout(workerEconomy, 'w');
  await cleared(withWorker, 3);
  // The first sweep submits the cash-out to the rail; the second finds it past its deadline.
  const worker = createWorker(withWorker, workerEconomy);
  const later = Date.now() + 30 * 24 * 3600_000;
  await worker.sweep({ now: later });
  // The submit itself queues nothing; a month of matured revenue is what the fee sweep finds.
  await cleared(withWorker, 1);
  await worker.sweep({ now: later });
  const fromWorker = only(await emitted(withWorker), 'economy.payout.reversed');

  const withOperator = labPorts();
  const operatorEconomy = createEconomy(withOperator);
  const sagaId = await fundAPayout(operatorEconomy, 'o');
  await cleared(withOperator, 3);
  await operatorEconomy.submit({
    kind: 'reversePayout',
    idempotencyKey: 'o4',
    actor: { kind: 'operator', operatorId: 'op_1' },
    userId: 'usr_seller',
    sagaId,
    reason: 'ops.manual',
  });
  const fromOperator = only(
    await emitted(withOperator),
    'economy.payout.reversed',
  );

  const fields = ['reason', 'reserve', 'sagaId', 'userId'];
  assert.deepEqual(Object.keys(fromWorker.data).sort(), fields);
  assert.deepEqual(Object.keys(fromOperator.data).sort(), fields);
  assert.equal(fromWorker.data.userId, 'usr_seller');
  assert.equal(fromOperator.data.userId, 'usr_seller');
  assert.equal(fromWorker.data.reserve, 'CREDIT:20000.00');
  assert.equal(fromOperator.data.reserve, 'CREDIT:20000.00');
  assert.equal(fromWorker.data.reason, 'payout.timeout');
  assert.equal(fromOperator.data.reason, 'ops.manual');
});

test('an instance session settles into the data this type declares', async () => {
  const ports = labPorts();
  const economy = createEconomy(ports);
  await economy.submit({
    kind: 'topUp',
    idempotencyKey: 'n1',
    actor: { kind: 'system', service: 'test' },
    userId: 'usr_ada',
    source: 'card',
    amount: decodeAmountWire('CREDIT:5000.00'),
  });
  await cleared(ports, 1);

  const lanes = openInstanceEconomies({
    store: ports.store,
    digest: ports.digest,
    clock: ports.clock,
    ids: ports.ids,
    pricing: ports.pricing,
    config: ports.config,
    logger: ports.logger,
    meter: ports.meter,
  });
  const outcome = await lanes.laneFor('wrld_1').purchase({
    buyerId: 'usr_ada',
    price: toAmount('CREDIT', 40_000n),
    recipients: [{ sellerId: 'usr_creator', shareBps: 10_000 }],
    product: { sku: 'wrld_hat', kind: 'permanent' },
  });
  assert.equal(outcome.status, 'accepted');
  await lanes.settleAll();

  const settled = only(await emitted(ports), 'economy.instance.settled');
  assert.deepEqual(Object.keys(settled.data).sort(), [
    'mode',
    'netted',
    'postings',
    'rejected',
    'revoked',
    'sessionId',
  ]);
  assert.equal(settled.data.mode, 'netted');
  assert.equal(settled.data.netted, 1);
  assert.equal(settled.data.postings, 1);
  assert.equal(settled.data.rejected, 0);
  assert.equal(settled.data.revoked, 0);
  assert.match(settled.data.sessionId, /^sess:wrld_1:/);
});

test('the operator lane emits the data promo, refund and clawback declare', async () => {
  const ports = labPorts();
  const economy = createEconomy(ports);
  const operator = { kind: 'operator', operatorId: 'op_1' } as const;

  await economy.submit({
    kind: 'grantPromo',
    idempotencyKey: 'g1',
    actor: operator,
    userId: 'usr_ada',
    amount: decodeAmountWire('CREDIT:1000.00'),
    expiresAt: Date.now() + 30 * 24 * 3600_000,
  });
  const promo = only(await emitted(ports), 'economy.promo.granted');
  assert.deepEqual(Object.keys(promo.data), ['txnId']);
  assert.match(promo.data.txnId, /^txn_/);
  assert.equal(promo.subject, 'usr_ada');

  await economy.submit({
    kind: 'topUp',
    idempotencyKey: 'g2',
    actor: { kind: 'system', service: 'test' },
    userId: 'usr_ada',
    source: 'card',
    amount: decodeAmountWire('CREDIT:30000.00'),
  });
  await economy.submit({
    kind: 'spend',
    idempotencyKey: 'g3',
    actor: { kind: 'user', userId: 'usr_ada' },
    orderId: 'ord_refundable',
    buyerId: 'usr_ada',
    sku: 'sku_hat',
    price: decodeAmountWire('CREDIT:12000.00'),
    recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
  });
  await cleared(ports, 2);

  await economy.submit({
    kind: 'refund',
    idempotencyKey: 'g4',
    actor: operator,
    orderId: 'ord_refundable',
    reason: 'ops.goodwill',
  });
  const refunded = only(await emitted(ports), 'economy.sale.refunded');
  assert.deepEqual(Object.keys(refunded.data).sort(), [
    'buyerId',
    'orderId',
    'txnId',
  ]);
  assert.equal(refunded.data.orderId, 'ord_refundable');
  assert.equal(refunded.data.buyerId, 'usr_ada');

  // A clawback naming an order shares the `reversed:${orderId}` key with a refund of that order, so
  // it must name a different sale or it answers duplicate and emits nothing.
  await economy.submit({
    kind: 'spend',
    idempotencyKey: 'g5',
    actor: { kind: 'user', userId: 'usr_ada' },
    orderId: 'ord_clawed',
    buyerId: 'usr_ada',
    sku: 'sku_boots',
    price: decodeAmountWire('CREDIT:8000.00'),
    recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
  });
  await cleared(ports, 1);
  await economy.submit({
    kind: 'clawback',
    idempotencyKey: 'g6',
    actor: operator,
    userId: 'usr_ada',
    amount: decodeAmountWire('CREDIT:2000.00'),
    orderId: 'ord_clawed',
    reason: 'ops.fraud',
  });
  const clawed = only(await emitted(ports), 'economy.credits.clawed_back');
  assert.deepEqual(Object.keys(clawed.data).sort(), [
    'amount',
    'orderId',
    'txnId',
    'userId',
  ]);
  assert.equal(clawed.data.userId, 'usr_ada');
  assert.equal(clawed.data.amount, 'CREDIT:2000.00');
  assert.equal(clawed.data.orderId, 'ord_clawed');
});

// One subscription walked end to end, because the four types are one state machine: the operation
// starts it, the billing worker renews and lapses it, the cancel operation ends it. Nothing but a
// real sweep produces renewed or lapsed.
test('a subscription emits started, renewed, canceled and lapsed', async () => {
  const ports = labPorts();
  const economy = createEconomy(ports);
  const worker = createWorker(ports, economy);
  const user = { kind: 'user', userId: 'usr_ada' } as const;
  const PERIOD = 30 * 24 * 3600_000;
  const started = Date.now();

  await economy.submit({
    kind: 'topUp',
    idempotencyKey: 's1',
    actor: { kind: 'system', service: 'test' },
    userId: 'usr_ada',
    source: 'card',
    amount: decodeAmountWire('CREDIT:30000.00'),
  });
  await cleared(ports, 1);

  const opened = await economy.submit({
    kind: 'subscribe',
    idempotencyKey: 's2',
    actor: user,
    userId: 'usr_ada',
    sellerId: 'usr_seller',
    sku: 'club_pass',
    price: decodeAmountWire('CREDIT:10000.00'),
    periodMs: PERIOD,
  });
  assert.equal(opened.status, 'committed');
  const subscriptionId = String(
    (opened.transaction.meta as { subscriptionId?: unknown }).subscriptionId,
  );
  const begun = only(await emitted(ports), 'economy.subscription.started');
  assert.deepEqual(Object.keys(begun.data).sort(), [
    'period',
    'sku',
    'subscriptionId',
    'txnId',
    'userId',
  ]);
  assert.equal(begun.data.sku, 'club_pass');
  assert.equal(begun.data.userId, 'usr_ada');
  assert.equal(begun.data.period, 1);

  // Five periods swept, and the wallet funds exactly two renewals: 30000 pays the opening charge
  // and two more at 10000, then the row finds an empty wallet and lapses. Asserting the whole
  // sequence rather than one sweep's output means a sweep that emits nothing, or an extra event, is
  // a failure here rather than a drain nobody reads.
  const lifecycle: KnownEvent[] = [];
  for (let period = 1; period <= 5; period += 1) {
    await worker.sweep({
      now: started + period * PERIOD + 60_000,
      only: ['subscriptions'],
    });
    lifecycle.push(...(await drain(ports)));
  }
  assert.deepEqual(
    lifecycle.map((event) => event.type),
    [
      'economy.subscription.renewed',
      'economy.subscription.renewed',
      'economy.subscription.lapsed',
    ],
    'two funded renewals, then the lapse, and nothing after it',
  );

  const [firstRenewal, , lapsedEvent] = lifecycle;
  const renewed = firstRenewal as Extract<
    KnownEvent,
    { type: 'economy.subscription.renewed' }
  >;
  assert.deepEqual(Object.keys(renewed.data).sort(), [
    'period',
    'sku',
    'subscriptionId',
    'txnId',
    'userId',
  ]);
  assert.equal(renewed.data.sku, 'club_pass');
  assert.equal(renewed.data.subscriptionId, subscriptionId);
  assert.equal(renewed.data.period, 2);

  const lapsed = lapsedEvent as Extract<
    KnownEvent,
    { type: 'economy.subscription.lapsed' }
  >;
  assert.deepEqual(Object.keys(lapsed.data).sort(), [
    'period',
    'sku',
    'subscriptionId',
    'userId',
  ]);
  assert.equal(lapsed.data.sku, 'club_pass');
  assert.equal(lapsed.data.userId, 'usr_ada');
  assert.equal(lapsed.data.subscriptionId, subscriptionId);

  // A second row, opened only so the cancel has something live to end.
  await economy.submit({
    kind: 'topUp',
    idempotencyKey: 's3',
    actor: { kind: 'system', service: 'test' },
    userId: 'usr_ben',
    source: 'card',
    amount: decodeAmountWire('CREDIT:20000.00'),
  });
  const second = await economy.submit({
    kind: 'subscribe',
    idempotencyKey: 's4',
    actor: { kind: 'user', userId: 'usr_ben' },
    userId: 'usr_ben',
    sellerId: 'usr_seller',
    sku: 'club_pass',
    price: decodeAmountWire('CREDIT:10000.00'),
    periodMs: PERIOD,
  });
  assert.equal(second.status, 'committed');
  await cleared(ports, 2);
  await economy.submit({
    kind: 'cancelSubscription',
    idempotencyKey: 's5',
    actor: { kind: 'user', userId: 'usr_ben' },
    subscriptionId: String(
      (second.transaction.meta as { subscriptionId?: unknown }).subscriptionId,
    ),
  });
  const canceled = only(await emitted(ports), 'economy.subscription.canceled');
  assert.deepEqual(Object.keys(canceled.data).sort(), [
    'subscriptionId',
    'txnId',
  ]);
  assert.notEqual(canceled.data.subscriptionId, subscriptionId);
});

/**
 * The one field a consumer switching on `type` reads off any subscription event, exactly as its
 * declared `data` offers it. A type outside the family has no place in the lifecycle and returns
 * null rather than a key that would group it with one.
 */
function joinKey(event: KnownEvent): string | null {
  switch (event.type) {
    case 'economy.subscription.started':
    case 'economy.subscription.renewed':
    case 'economy.subscription.lapsed':
    case 'economy.subscription.canceled':
      return event.data.subscriptionId;
    default:
      return null;
  }
}

/** The lifecycle a consumer reconstructs for one subscription, in the order it was emitted. */
function joined(events: KnownEvent[], subscriptionId: string): string[] {
  return events
    .filter((event) => joinKey(event) === subscriptionId)
    .map((event) => event.type);
}

// The subscription the reader created, read back through the ordinary door. The posting metadata
// is where the emitters take the id from, so an expectation drawn from there would hold however
// wrong the events were; this row is the independent side of the join.
async function openedRow(
  economy: ReturnType<typeof createEconomy>,
  userId: string,
): Promise<{ id: string; sku: string }> {
  const rows: Array<{ id: string; sku: string }> = [];
  for await (const row of economy.read.subscriptions(userId)) {
    rows.push(row);
  }
  assert.equal(rows.length, 1, `${userId} holds ${rows.length} subscriptions`);
  return rows[0];
}

/**
 * The consumer's problem rather than the emitter's: four types are one state machine, and someone
 * holding the first event has to find the other three. `(userId, sku)` cannot do it — a user who
 * lapses and subscribes again reuses that pair — so the events have to name the row.
 *
 * Two subscriptions run at once, sharing a sku and a seller, and the second is the control: a join
 * field that was a constant, or a reader that fell back to the user, would put both lifecycles in
 * one bucket, and only the second exact-list assertion catches that.
 */
test('a consumer joins a whole subscription lifecycle on one field', async () => {
  const ports = labPorts();
  const economy = createEconomy(ports);
  const worker = createWorker(ports, economy);
  const PERIOD = 30 * 24 * 3600_000;
  const opened = Date.now();

  for (const [key, userId] of [
    ['j1', 'usr_ada'],
    ['j2', 'usr_ben'],
  ]) {
    await economy.submit({
      kind: 'topUp',
      idempotencyKey: key,
      actor: { kind: 'system', service: 'test' },
      userId,
      source: 'card',
      amount: decodeAmountWire('CREDIT:20000.00'),
    });
    await economy.submit({
      kind: 'subscribe',
      idempotencyKey: `${key}s`,
      actor: { kind: 'user', userId },
      userId,
      sellerId: 'usr_seller',
      sku: 'club_pass',
      price: decodeAmountWire('CREDIT:10000.00'),
      periodMs: PERIOD,
    });
  }
  const mine = await openedRow(economy, 'usr_ada');
  const theirs = await openedRow(economy, 'usr_ben');
  assert.equal(mine.sku, theirs.sku, 'the two rows share a sku, as intended');

  // Cancel before any sweep, so this row leaves the lifecycle by the door the other one does not.
  await economy.submit({
    kind: 'cancelSubscription',
    idempotencyKey: 'j3',
    actor: { kind: 'user', userId: 'usr_ben' },
    subscriptionId: theirs.id,
  });

  // Everything a consumer would have received, in one pool, the way a subscriber to the stream
  // sees it: two subscriptions interleaved, with nothing sorting them but what they carry.
  const stream: KnownEvent[] = [...(await emitted(ports))];
  for (let period = 1; period <= 3; period += 1) {
    await worker.sweep({
      now: opened + period * PERIOD + 60_000,
      only: ['subscriptions'],
    });
    stream.push(...(await drain(ports)));
  }
  assert.deepEqual(
    stream
      .map((event) => event.type)
      .filter((type) => type.startsWith('economy.subscription.')),
    [
      'economy.subscription.started',
      'economy.subscription.started',
      'economy.subscription.canceled',
      'economy.subscription.renewed',
      'economy.subscription.lapsed',
    ],
    'the five subscription events this walk produces, before anything is joined',
  );

  assert.deepEqual(
    joined(stream, mine.id),
    [
      'economy.subscription.started',
      'economy.subscription.renewed',
      'economy.subscription.lapsed',
    ],
    'a consumer holding the started event cannot reach the rest of its own lifecycle',
  );
  assert.deepEqual(
    joined(stream, theirs.id),
    ['economy.subscription.started', 'economy.subscription.canceled'],
    'the second lifecycle does not join on its own id',
  );
  assert.equal(
    joined(stream, mine.id + '_absent').length,
    0,
    'an id no subscription was ever opened under still gathers a lifecycle',
  );
});

/** Every renewal event the pool holds for one subscription, in emission order. */
function renewalsOf(
  events: KnownEvent[],
  subscriptionId: string,
): Array<Extract<KnownEvent, { type: 'economy.subscription.renewed' }>> {
  const renewals = events.filter(
    (
      event,
    ): event is Extract<KnownEvent, { type: 'economy.subscription.renewed' }> =>
      event.type === 'economy.subscription.renewed',
  );
  return renewals.filter(
    (event) => event.data.subscriptionId === subscriptionId,
  );
}

/**
 * What the LEDGER says billed one subscription, oldest first — the independent side of the
 * reconciliation. `read.postings` streams newest first, so this reverses.
 */
async function chargesFor(
  economy: ReturnType<typeof createEconomy>,
  subscriptionId: string,
): Promise<string[]> {
  const charges: string[] = [];
  for await (const posting of economy.read.postings()) {
    if (
      posting.meta.kind === 'subscriptions.renew' &&
      posting.meta.subscriptionId === subscriptionId
    ) {
      charges.push(posting.txnId);
    }
  }
  return charges.reverse();
}

/**
 * The second half of the consumer's problem: a renewal event announces a charge, and a charge has
 * to be reconcilable. `subscriptionId` reaches the lifecycle; `txnId` reaches the money, through
 * `read.posting` — the door a reader resolves a transaction id with.
 *
 * The ledger's own renewal charges are collected first and the events compared against them as an
 * exact ordered list, so naming the opening charge, the same posting twice, or the other row's is a
 * failure rather than a present field. **Two subscriptions bill in every sweep** for that last one:
 * an emitter that named whichever renewal posted most recently would satisfy a single-row walk, and
 * the two rows share a sku, a seller and a price, so nothing but the posting tells them apart.
 */
test('a renewal event names the posting that billed it', async () => {
  const ports = labPorts();
  const economy = createEconomy(ports);
  const worker = createWorker(ports, economy);
  const PERIOD = 30 * 24 * 3600_000;
  const opened = Date.now();

  // 30000 buys the opening period and exactly two renewals, so the third sweep finds both wallets
  // empty and lapses both rows — the lapse is here to be the neighbour that names no posting.
  for (const [key, userId] of [
    ['n1', 'usr_ada'],
    ['n2', 'usr_ben'],
  ]) {
    await economy.submit({
      kind: 'topUp',
      idempotencyKey: key,
      actor: { kind: 'system', service: 'test' },
      userId,
      source: 'card',
      amount: decodeAmountWire('CREDIT:30000.00'),
    });
    await economy.submit({
      kind: 'subscribe',
      idempotencyKey: `${key}s`,
      actor: { kind: 'user', userId },
      userId,
      sellerId: 'usr_seller',
      sku: 'club_pass',
      price: decodeAmountWire('CREDIT:10000.00'),
      periodMs: PERIOD,
    });
  }
  const mine = await openedRow(economy, 'usr_ada');
  const theirs = await openedRow(economy, 'usr_ben');
  await cleared(ports, 4);

  const stream: KnownEvent[] = [];
  for (let period = 1; period <= 3; period += 1) {
    await worker.sweep({
      now: opened + period * PERIOD + 60_000,
      only: ['subscriptions'],
    });
    stream.push(...(await drain(ports)));
  }
  assert.deepEqual(
    stream.map((event) => event.type),
    [
      'economy.subscription.renewed',
      'economy.subscription.renewed',
      'economy.subscription.renewed',
      'economy.subscription.renewed',
      'economy.subscription.lapsed',
      'economy.subscription.lapsed',
    ],
    'two rows, two funded renewals each, then both lapse',
  );

  const billedMine = await chargesFor(economy, mine.id);
  const billedTheirs = await chargesFor(economy, theirs.id);
  assert.equal(
    billedMine.length,
    2,
    `the ledger holds ${billedMine.length} renewal charges for the first row, not 2`,
  );
  assert.equal(
    billedTheirs.length,
    2,
    `the ledger holds ${billedTheirs.length} renewal charges for the second row, not 2`,
  );

  assert.deepEqual(
    renewalsOf(stream, mine.id).map((event) => event.data.txnId),
    billedMine,
    'the renewal events do not name the postings that billed this subscription',
  );
  assert.deepEqual(
    renewalsOf(stream, theirs.id).map((event) => event.data.txnId),
    billedTheirs,
    'the second row is announced with the wrong postings',
  );

  // Then the reconciliation a consumer actually performs: take the id off the event and read the
  // posting, so the amount billed comes from the ledger rather than from the event's word.
  const renewals = renewalsOf(stream, mine.id).concat(
    renewalsOf(stream, theirs.id),
  );
  let reconciled = 0;
  for (const event of renewals) {
    const posting = await economy.read.posting(event.data.txnId);
    assert.ok(
      posting !== null,
      `${event.data.txnId} resolves to no posting at all`,
    );
    assert.equal(
      posting.meta.kind,
      'subscriptions.renew',
      'the announced posting is not a renewal charge',
    );
    const paid = posting.legs.find(
      (leg) => leg.account === spendable(event.data.userId),
    );
    assert.ok(
      paid !== undefined,
      'the announced posting never debits the buyer the event names',
    );
    assert.equal(
      encodeAmount(paid.amount),
      'CREDIT:10000.00',
      'the announced posting bills something other than the subscription price',
    );
    reconciled += 1;
  }
  assert.equal(
    reconciled,
    4,
    `reconciled ${reconciled} renewal events against the ledger, expected 4`,
  );

  // The neighbour: a lapse posts nothing, so it names nothing. This is what the split type says,
  // and `tsc` is the other half of it — `data.txnId` does not compile on this branch.
  const lapses = stream.filter(
    (event) => event.type === 'economy.subscription.lapsed',
  );
  assert.equal(lapses.length, 2, 'both rows lapsed');
  for (const lapse of lapses) {
    assert.deepEqual(Object.keys(lapse.data).sort(), [
      'period',
      'sku',
      'subscriptionId',
      'userId',
    ]);
  }
});

// PayoutSettledData's doc makes a claim no type can carry: "the USD figures are the rate-derived
// ones, not the rail's report". The rail is told a different number here, so the event either
// carries the derived figures or the claim is false.
test('a settled payout carries the rate-derived USD, not the rail report', async () => {
  const ports = labPorts();
  const economy = createEconomy(ports);
  const worker = createWorker(ports, economy);
  const sagaId = await fundAPayout(economy, 'p');
  await cleared(ports, 3);

  // SUBMITTED is the only state a settle is accepted from, and only the sweep gets it there.
  await worker.sweep({ now: Date.now() + 3600_000, only: ['payouts'] });
  await cleared(ports, 0);

  const settle = await economy.submit({
    kind: 'settlePayout',
    idempotencyKey: 'p4',
    actor: { kind: 'system', service: 'rail' },
    sagaId,
    providerRef: 'mem_1',
    providerAmount: decodeAmountWire('USD:1.00'),
  });
  assert.equal(settle.status, 'committed');

  const settled = only(await emitted(ports), 'economy.payout.settled');
  assert.deepEqual(Object.keys(settled.data).sort(), [
    'netUsd',
    'payoutFee',
    'rateId',
    'reserve',
    'sagaId',
    'usd',
    'userId',
  ]);
  assert.equal(settled.data.sagaId, sagaId);
  assert.equal(settled.data.userId, 'usr_seller');
  assert.equal(settled.data.reserve, 'CREDIT:20000.00');
  assert.equal(settled.data.usd, 'USD:100.00');
  assert.equal(settled.data.payoutFee, 'USD:1.50');
  assert.equal(settled.data.netUsd, 'USD:98.50');
  assert.notEqual(
    settled.data.usd,
    'USD:1.00',
    "the rail reported a dollar; the event carries the rate's hundred",
  );
  assert.match(settled.data.rateId, /^payout:CREDIT->USD:/);
});

test('a fee sweep emits what it moved', async () => {
  const ports = labPorts();
  const economy = createEconomy(ports);
  const worker = createWorker(ports, economy);
  await fundAPayout(economy, 'f');
  await cleared(ports, 3);

  // A month on, the platform's cut of that sale has matured and the sweep drains it.
  await worker.sweep({ now: Date.now() + 30 * 24 * 3600_000 });
  const swept = only(await emitted(ports), 'economy.fees.swept');
  assert.deepEqual(Object.keys(swept.data), ['swept']);
  // The platform's 1530 bps of the 25000-credit sale, and nothing else: the seller's reserve is
  // still held against the open cash-out, so it is not sweepable revenue yet.
  assert.equal(swept.data.swept, 'CREDIT:3825.00');
  assert.match(
    swept.subject,
    /^txn_/,
    'the subject ties the event to its posting',
  );
});

// The lane's two backstop counts are only ever seen at zero, so nothing says they count anything.
// A movement accepted in-session and refused at settle produces both: the ledger declines the
// posting, and the grant it had already handed out is taken back.
test('a settle whose replay is refused reports the rejection and the revoke', async () => {
  const ports = labPorts();
  const economy = createEconomy(ports);
  await economy.submit({
    kind: 'topUp',
    idempotencyKey: 'r1',
    actor: { kind: 'system', service: 'test' },
    userId: 'usr_ada',
    source: 'card',
    amount: decodeAmountWire('CREDIT:5000.00'),
  });
  await cleared(ports, 1);

  const lanes = openInstanceEconomies({
    store: ports.store,
    digest: ports.digest,
    clock: ports.clock,
    ids: ports.ids,
    pricing: ports.pricing,
    config: ports.config,
    logger: ports.logger,
    meter: ports.meter,
  });
  const accepted = await lanes.laneFor('wrld_2').purchase({
    buyerId: 'usr_ada',
    price: toAmount('CREDIT', 40_000n),
    recipients: [{ sellerId: 'usr_creator', shareBps: 10_000 }],
    product: { sku: 'wrld_cape', kind: 'permanent' },
  });
  assert.equal(accepted.status, 'accepted');

  // The session accepted on a balance it does not hold once this spend lands.
  const drained = await economy.submit({
    kind: 'spend',
    idempotencyKey: 'r2',
    actor: { kind: 'user', userId: 'usr_ada' },
    orderId: 'ord_drain',
    buyerId: 'usr_ada',
    sku: 'sku_everything',
    price: decodeAmountWire('CREDIT:5000.00'),
    recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
  });
  assert.equal(drained.status, 'committed');
  await cleared(ports, 1);
  await lanes.settleAll();

  const settled = only(await emitted(ports), 'economy.instance.settled');
  assert.equal(settled.data.mode, 'replayed');
  assert.equal(settled.data.postings, 0);
  assert.equal(settled.data.netted, 1);
  assert.equal(settled.data.rejected, 1, 'the refused movement is counted');
  assert.equal(settled.data.revoked, 1, 'and its grant is taken back');
});

// The roster is fourteen names; a declared `data` shape that no scenario above produces is checked
// by TypeScript against the file that declares it and by nothing else. This is the count of types
// this file examined, asserted against the roster rather than against itself.
test('every rostered type was produced and read back', () => {
  assert.deepEqual([...SEEN].sort(), [...EVENT_TYPES].sort());
  assert.equal(SEEN.size, 14, `read ${SEEN.size} of the fourteen types`);
});

// Earns a seller enough to request the minimum cash-out, then returns the saga that opened.
async function fundAPayout(
  economy: ReturnType<typeof createEconomy>,
  tag: string,
): Promise<string> {
  await economy.submit({
    kind: 'topUp',
    idempotencyKey: `${tag}1`,
    actor: { kind: 'system', service: 'test' },
    userId: 'usr_ada',
    source: 'card',
    amount: decodeAmountWire('CREDIT:30000.00'),
  });
  await economy.submit({
    kind: 'spend',
    idempotencyKey: `${tag}2`,
    actor: { kind: 'user', userId: 'usr_ada' },
    orderId: `ord_${tag}`,
    buyerId: 'usr_ada',
    sku: 'sku_hat',
    price: decodeAmountWire('CREDIT:25000.00'),
    recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
  });
  const outcome = await economy.submit({
    kind: 'requestPayout',
    idempotencyKey: `${tag}3`,
    actor: { kind: 'user', userId: 'usr_seller' },
    userId: 'usr_seller',
    amount: decodeAmountWire('CREDIT:20000.00'),
  });
  assert.equal(outcome.status, 'committed');
  return String((outcome.transaction.meta as { sagaId?: unknown }).sagaId);
}
