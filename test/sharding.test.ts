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
 * Platform-account sharding (`config.platformShards`, src/accounts.ts), proven at 4 shards
 * in-memory — every other suite runs at the default of 1. Two rules up front: a shard behaves
 * exactly like its parent account, and PAYOUT_RESERVE routes by user id so a settle or reverse
 * drains the shard its request credited.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { makeEconomy } from '#test/support/economy.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { realizeFees } from '#src/worker/treasury.ts';
import {
  SYSTEM,
  baseOf,
  classify,
  currency,
  earned,
  isDebitNormal,
  platformShard,
  promo,
  routePlatformLegs,
  shardRef,
  shardsOf,
  spendable,
} from '#src/accounts.ts';
import {
  credit,
  grantPromo,
  refund,
  requestPayout,
  settlePayout,
  spend,
  topUp,
  usd,
} from '#test/support/builders.ts';
import {
  fakeProcessor,
  fixedClock,
  fixedRates,
  noopMeter,
  seededDigest,
  seededSigner,
  sequentialIds,
  testConfig,
  testLogger,
} from '#test/support/capabilities.ts';
import { resolveConfig } from '#scripts/support/harness.ts';

import type { AccountRef } from '#src/accounts.ts';
import type { Economy, Operation, Outcome, WorkerCtx } from '#src/contract.ts';
import type { Saga, Store } from '#src/ports.ts';

const SHARDS = 4;

// The platform accounts that shard (accounts.ts SHARDED). RECEIVABLE and OPENING_EQUITY move rarely
// and stay single rows, so they are deliberately absent.
const SHARDED_SET: AccountRef[] = [
  SYSTEM.REVENUE,
  SYSTEM.PROMO_FLOAT,
  SYSTEM.STORED_VALUE,
  SYSTEM.TRUST_CASH,
  SYSTEM.USD_CLEARING,
  SYSTEM.REVENUE_USD,
  SYSTEM.PAYOUT_RESERVE,
];

// The store is built here so store and economy share one digest and clock.
function shardedEconomy(seed = 1): { economy: Economy; store: Store } {
  const store = memoryStore({
    digest: seededDigest(seed),
    clock: fixedClock(0),
  });
  const economy = makeEconomy(seed, store, { platformShards: SHARDS });
  return { economy, store };
}

// A sharded account's balance is the sum over its shards; a single shard's is meaningless alone.
async function logicalBalance(store: Store, base: AccountRef): Promise<bigint> {
  let total = 0n;
  for (const shard of shardsOf(base, SHARDS)) {
    total += (await store.ledger.balance(shard)).minor;
  }
  return total;
}

function committedTxn(
  outcome: Outcome,
): Extract<Outcome, { status: 'committed' }>['transaction'] {
  assert.equal(outcome.status, 'committed');
  return (outcome as Extract<Outcome, { status: 'committed' }>).transaction;
}

// Asserts every invariant in a prove report individually, so a failure names the broken one.
async function proveAll(economy: Economy): Promise<void> {
  const report = await economy.read.prove();
  assert.equal(report.conserved, true);
  assert.equal(report.backed, true);
  assert.equal(report.noOverdraft, true);
  assert.equal(report.chainIntact, true);
  assert.equal(report.consistent, true);
}

// Finds the one payout saga a test opened for a user. The payout tests open exactly one each.
async function sagaFor(store: Store, userId: string): Promise<Saga> {
  for await (const saga of store.sagas.list()) {
    if (saga.userId === userId) {
      return saga;
    }
  }
  throw new Error(`no saga for ${userId}`);
}

// The key routes the hot platform legs, so byte-for-byte reproduction needs pinned keys.
function withKey(operation: Operation, idempotencyKey: string): Operation {
  return { ...operation, idempotencyKey };
}

// Earns a seller a payable balance the way production does: a funded buyer purchases from them.
// At the 3000 bps test fee, a 100.00 sale nets the seller 70.00.
async function earnSeller(
  economy: Economy,
  seller: string,
  buyer: string,
): Promise<void> {
  const funded = await economy.submit(
    topUp({ userId: buyer, amount: credit('1000.00') }),
  );
  assert.equal(funded.status, 'committed');
  const sale = await economy.submit(
    spend({
      buyerId: buyer,
      sku: 'wrld_pass',
      price: credit('100.00'),
      recipients: [{ sellerId: seller, shareBps: 10_000 }],
    }),
  );
  assert.equal(sale.status, 'committed');
}

describe('Sharding: Identity', () => {
  test('every shard inherits its parent currency, class, and normal side', () => {
    for (const base of SHARDED_SET) {
      for (const k of [1, 2, 3]) {
        const shard = shardRef(base, k);
        assert.equal(currency(shard), currency(base));
        assert.equal(classify(shard), classify(base));
        assert.equal(isDebitNormal(shard), isDebitNormal(base));
        assert.equal(baseOf(shard), base);
      }
    }
  });

  test('shard 0 is the bare id, and shardsOf lists it first', () => {
    for (const base of SHARDED_SET) {
      assert.equal(shardRef(base, 0), base);
      const shards = shardsOf(base, SHARDS);
      assert.equal(shards.length, SHARDS);
      assert.equal(shards[0], base);
    }
  });

  test('platformShard is deterministic and spreads distinct keys across shards', () => {
    const known = shardsOf(SYSTEM.REVENUE, SHARDS);
    const routed = new Set<AccountRef>();
    for (let i = 0; i < 300; i++) {
      const key = `key_${i}`;
      const first = platformShard(SYSTEM.REVENUE, key, SHARDS);
      assert.equal(platformShard(SYSTEM.REVENUE, key, SHARDS), first);
      assert.equal(known.includes(first), true);
      routed.add(first);
    }
    assert.equal(routed.size > 1, true);
  });

  test('a shard count of 1 and non-sharded accounts pass through unchanged', () => {
    assert.equal(platformShard(SYSTEM.REVENUE, 'any', 1), SYSTEM.REVENUE);
    const legs = [{ account: SYSTEM.REVENUE }];
    assert.equal(routePlatformLegs(legs, 'any', 1), legs);
    assert.equal(
      platformShard(SYSTEM.RECEIVABLE, 'any', SHARDS),
      SYSTEM.RECEIVABLE,
    );
    assert.equal(
      platformShard(spendable('usr_a'), 'any', SHARDS),
      spendable('usr_a'),
    );
  });
});

describe('Sharding: Leg Routing', () => {
  test('a committed posting lands its hot platform legs on the key-routed shard', async () => {
    const { economy } = shardedEconomy();

    const up = topUp({ userId: 'usr_route', amount: credit('10.00') });
    const issuance = committedTxn(await economy.submit(up));
    const storedLeg = issuance.legs.find(
      (leg) => baseOf(leg.account) === SYSTEM.STORED_VALUE,
    );
    assert.equal(
      storedLeg?.account,
      platformShard(SYSTEM.STORED_VALUE, up.idempotencyKey, SHARDS),
    );

    const sale = spend({
      buyerId: 'usr_route',
      sku: 'wrld_pass',
      price: credit('4.00'),
      recipients: [{ sellerId: 'usr_route_seller', shareBps: 10_000 }],
    });
    const posting = committedTxn(await economy.submit(sale));
    const revenueLeg = posting.legs.find(
      (leg) => baseOf(leg.account) === SYSTEM.REVENUE,
    );
    assert.equal(
      revenueLeg?.account,
      platformShard(SYSTEM.REVENUE, sale.idempotencyKey, SHARDS),
    );
  });
});

describe('Sharding: Lifecycle', () => {
  test('top-ups, spends, and a promo-funded spend commit, prove, and total exactly', async () => {
    const { economy, store } = shardedEconomy();

    // Six independent buyer/seller pairs, distinct idempotency keys, so the postings spread.
    for (let i = 0; i < 6; i++) {
      const funded = await economy.submit(
        topUp({ userId: `usr_b${i}`, amount: credit('10.00') }),
      );
      assert.equal(funded.status, 'committed');
    }
    for (let i = 0; i < 6; i++) {
      const sale = await economy.submit(
        spend({
          buyerId: `usr_b${i}`,
          sku: 'wrld_pass',
          price: credit('4.00'),
          recipients: [{ sellerId: `usr_s${i}`, shareBps: 10_000 }],
        }),
      );
      assert.equal(sale.status, 'committed');
    }

    // One promo-funded purchase: the grant covers the whole price, so no spendable is touched.
    const granted = await economy.submit(
      grantPromo({ userId: 'usr_pb', amount: credit('5.00') }),
    );
    assert.equal(granted.status, 'committed');
    const promoSale = await economy.submit(
      spend({
        buyerId: 'usr_pb',
        sku: 'wrld_pass',
        price: credit('4.00'),
        recipients: [{ sellerId: 'usr_ps', shareBps: 10_000 }],
      }),
    );
    assert.equal(promoSale.status, 'committed');

    await proveAll(economy);

    // The logical REVENUE total, from the fee config: 3000 bps of 4.00 is 1.20, rounded up to the
    // whole credit 2.00 per spendable-funded sale (feeForPrice), and a 10000 bps seller leaves no
    // residual. Six sales earn 12.00. The promo-funded sale pays its seller 4.00 out of REVENUE
    // (no fee on the promo part), so the account nets 8.00 across its shards.
    assert.equal(
      await logicalBalance(store, SYSTEM.REVENUE),
      credit('8.00').minor,
    );
    assert.equal(
      await logicalBalance(store, SYSTEM.STORED_VALUE),
      credit('60.00').minor,
    );
    // The promo float holds the 5.00 grant less the 4.00 spent back.
    assert.equal(
      await logicalBalance(store, SYSTEM.PROMO_FLOAT),
      credit('1.00').minor,
    );

    for (let i = 0; i < 6; i++) {
      assert.deepEqual(
        await store.ledger.balance(spendable(`usr_b${i}`)),
        credit('6.00'),
      );
      assert.deepEqual(
        await store.ledger.balance(earned(`usr_s${i}`)),
        credit('2.00'),
      );
    }
    assert.deepEqual(
      await store.ledger.balance(promo('usr_pb')),
      credit('1.00'),
    );
    assert.deepEqual(
      await store.ledger.balance(earned('usr_ps')),
      credit('4.00'),
    );
  });
});

describe('Sharding: Payout Round-Trip', () => {
  test('a payout settles against the same reserve shard its request credited', async () => {
    const { economy, store } = shardedEconomy();
    await earnSeller(economy, 'usr_seller', 'usr_buyer');

    const request = requestPayout({
      userId: 'usr_seller',
      amount: credit('10.00'),
    });
    const reserved = committedTxn(await economy.submit(request));
    // The reserve routes by the USER id, not the request key: the settle and reverse know only the
    // saga, and the saga knows the user, so per-user routing is what lets them find this credit.
    const reserveLeg = reserved.legs.find(
      (leg) => baseOf(leg.account) === SYSTEM.PAYOUT_RESERVE,
    );
    assert.equal(
      reserveLeg?.account,
      platformShard(SYSTEM.PAYOUT_RESERVE, 'usr_seller', SHARDS),
    );

    // Hand the payout to the provider the way the worker does, so the settle sees SUBMITTED.
    const saga = await sagaFor(store, 'usr_seller');
    assert.equal(saga.state, 'RESERVED');
    const advanced = await store.sagas.advance(
      saga.id,
      'RESERVED',
      'SUBMITTED',
      {
        providerRef: 'prov_test',
        updatedAt: 0,
      },
    );
    assert.equal(advanced, true);

    // The reserve is overdraft-guarded per row, so a settle on any other shard would fault instead
    // of committing.
    const settled = await economy.submit(settlePayout({ sagaId: saga.id }));
    assert.equal(settled.status, 'committed');
    assert.equal((await store.sagas.load(saga.id))?.state, 'SETTLED');

    // The reserve is empty on every shard, not merely in total.
    for (const shard of shardsOf(SYSTEM.PAYOUT_RESERVE, SHARDS)) {
      assert.deepEqual(await store.ledger.balance(shard), credit('0.00'));
    }
    await proveAll(economy);
  });

  test('a payout reverses back to earned from the same reserve shard', async () => {
    const { economy, store } = shardedEconomy();
    await earnSeller(economy, 'usr_seller', 'usr_buyer');

    const reserved = await economy.submit(
      requestPayout({ userId: 'usr_seller', amount: credit('10.00') }),
    );
    assert.equal(reserved.status, 'committed');

    const saga = await sagaFor(store, 'usr_seller');
    const reversal: Operation = {
      kind: 'reversePayout',
      idempotencyKey: `idem_rev_${saga.id}`,
      actor: { kind: 'operator', operatorId: 'op_test' },
      userId: 'usr_seller',
      sagaId: saga.id,
      reason: 'fraud hold',
    };
    const reversed = await economy.submit(reversal);
    assert.equal(reversed.status, 'committed');
    assert.equal((await store.sagas.load(saga.id))?.state, 'FAILED');

    assert.deepEqual(
      await store.ledger.balance(earned('usr_seller')),
      credit('70.00'),
    );
    for (const shard of shardsOf(SYSTEM.PAYOUT_RESERVE, SHARDS)) {
      assert.deepEqual(await store.ledger.balance(shard), credit('0.00'));
    }
    await proveAll(economy);
  });
});

describe('Sharding: Refund', () => {
  test('a refund nets the revenue shards back down and still proves', async () => {
    const { economy, store } = shardedEconomy();
    const funded = await economy.submit(
      topUp({ userId: 'usr_rb', amount: credit('10.00') }),
    );
    assert.equal(funded.status, 'committed');
    const sale = await economy.submit(
      spend({
        buyerId: 'usr_rb',
        sku: 'wrld_pass',
        price: credit('4.00'),
        orderId: 'ord_shard_refund',
        recipients: [{ sellerId: 'usr_rs', shareBps: 10_000 }],
      }),
    );
    assert.equal(sale.status, 'committed');
    assert.equal(
      await logicalBalance(store, SYSTEM.REVENUE),
      credit('2.00').minor,
    );

    // The refund reverses the recorded legs, so the clawback hits the same shard the fee landed on.
    const refunded = await economy.submit(
      refund({ orderId: 'ord_shard_refund' }),
    );
    assert.equal(refunded.status, 'committed');
    assert.equal(await logicalBalance(store, SYSTEM.REVENUE), 0n);
    assert.deepEqual(
      await store.ledger.balance(spendable('usr_rb')),
      credit('10.00'),
    );
    assert.deepEqual(
      await store.ledger.balance(earned('usr_rs')),
      credit('0.00'),
    );
    await proveAll(economy);
  });
});

describe('Sharding: Determinism', () => {
  // The identical seed and operations, keys and orderIds pinned (the key picks the shard, and the
  // orderId is hashed into the posting meta, so both must match run to run).
  async function fixedWorkload(economy: Economy): Promise<void> {
    for (let i = 0; i < 4; i++) {
      const funded = await economy.submit(
        withKey(
          topUp({ userId: `usr_d${i}`, amount: credit('10.00') }),
          `idem_det_up_${i}`,
        ),
      );
      assert.equal(funded.status, 'committed');
    }
    for (let i = 0; i < 4; i++) {
      const sale = await economy.submit(
        withKey(
          spend({
            buyerId: `usr_d${i}`,
            sku: 'wrld_pass',
            price: credit('4.00'),
            orderId: `ord_det_${i}`,
            recipients: [{ sellerId: `usr_ds${i}`, shareBps: 10_000 }],
          }),
          `idem_det_sp_${i}`,
        ),
      );
      assert.equal(sale.status, 'committed');
    }
  }

  async function headsOf(store: Store): Promise<Map<AccountRef, string>> {
    const heads = new Map<AccountRef, string>();
    for await (const [account, head] of store.ledger.heads()) {
      heads.set(account, head);
    }
    return heads;
  }

  test('two identically built economies end with identical account heads', async () => {
    const first = shardedEconomy(7);
    await fixedWorkload(first.economy);
    const second = shardedEconomy(7);
    await fixedWorkload(second.economy);

    const firstHeads = await headsOf(first.store);
    const secondHeads = await headsOf(second.store);
    assert.equal(firstHeads.size > 0, true);
    assert.deepEqual(firstHeads, secondHeads);
  });
});

describe('Sharding: Fee Sweep', () => {
  test('a fee sweep realizes the full logical matured revenue, not just shard 0', async () => {
    const { economy, store } = shardedEconomy();
    // Two sales with distinct keys, so the 2.00 fees can land on different REVENUE shards. Trust
    // holds 2 × $0.05 of backing; custodial drops to 12.00 after the spends, so at the $0.005 par
    // the surplus (20.00 credits of trust minus 12.00 owed) exceeds the 4.00 of matured revenue and
    // the revenue cap binds.
    for (let i = 0; i < 2; i++) {
      const funded = await economy.submit(
        topUp({ userId: `usr_f${i}`, amount: credit('10.00') }),
      );
      assert.equal(funded.status, 'committed');
      const sale = await economy.submit(
        spend({
          buyerId: `usr_f${i}`,
          sku: 'wrld_pass',
          price: credit('4.00'),
          recipients: [{ sellerId: `usr_fs${i}`, shareBps: 10_000 }],
        }),
      );
      assert.equal(sale.status, 'committed');
    }
    assert.equal(
      await logicalBalance(store, SYSTEM.REVENUE),
      credit('4.00').minor,
    );

    // Ids seeded far above the economy's counter so the sweep's txn ids cannot collide.
    const ctx: WorkerCtx = {
      clock: fixedClock(0),
      ids: sequentialIds(500),
      digest: seededDigest(1),
      signer: seededSigner(1),
      processor: fakeProcessor(),
      rates: fixedRates(),
      logger: testLogger(),
      meter: noopMeter(),
      config: { ...testConfig(), platformShards: SHARDS },
    };
    const summary = await realizeFees(store, ctx, { now: 1_000 });

    assert.equal(summary.skipped, false);
    assert.equal(summary.duplicate, false);
    assert.equal(summary.swept, 'CREDIT:4.00');
    assert.equal(await logicalBalance(store, SYSTEM.REVENUE), 0n);
    // Custody cash dropped by the swept fees at the $0.005 par: $0.10 minus $0.02.
    assert.equal(
      await logicalBalance(store, SYSTEM.TRUST_CASH),
      usd('0.08').minor,
    );
    await proveAll(economy);
  });
});

describe('Sharding: Bench Knob', () => {
  test('BENCH_SHARDS resolves into the harness config, defaulting to 1', () => {
    assert.equal(resolveConfig({}).shards, 1);
    assert.equal(resolveConfig({ BENCH_SHARDS: '4' }).shards, 4);
  });
});
