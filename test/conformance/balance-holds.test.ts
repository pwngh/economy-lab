/// <reference types="node" />
/**
 * @pwngh/economy-lab
 * Copyright (c) Preston Neal
 * Licensed under the MIT license in LICENSE.md.
 */

import '#test/support/dist-guard.ts';
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createBalanceHolds } from '#src/balance-holds.ts';
import { balanceHoldAccount, earned, SYSTEM } from '#src/accounts.ts';
import { credit, debit, lockAll, postEntry } from '#src/ledger.ts';
import { checkedConfig } from '#src/config.ts';
import { createEconomy } from '#src/economy.ts';
import { requestPayout } from '#src/operation.ts';
import { toAmount } from '#src/money.ts';
import { adapterMatrix } from '#test/support/adapters.ts';
import {
  hasCode,
  makePorts,
  seededDigest,
  testConfig,
} from '#test/support/capabilities.ts';
import { array, check, choice, int, record } from '#test/support/propcheck.ts';
import type { Store } from '#src/ports.ts';
import type { Operation } from '#src/contract.ts';

const amount = (minor: bigint) => toAmount('CREDIT', minor);
const config = checkedConfig({
  ...testConfig(),
  maturityHorizonMs: { card: 100, instant: 0, default: 100 },
});
let fixtureId = 0;

function fixture(store: Store, ownerId?: string) {
  const fixtureNumber = ++fixtureId;
  const userId = ownerId ?? `usr_balance_${fixtureNumber}`;
  let time = 0;
  let id = 0;
  const holds = createBalanceHolds({ store, config, digest: seededDigest(1) });
  const economy = createEconomy(
    makePorts(store, {
      config,
      clock: { now: () => time },
      ids: { next: (prefix) => `${prefix}_balance_${fixtureNumber}_${++id}` },
    }),
  );
  return {
    userId,
    holds,
    economy,
    now: () => time,
    at: (now: number) => {
      time = now;
    },
    payout: (minor: bigint, key: string) =>
      requestPayout({
        userId,
        amount: amount(minor),
        idempotencyKey: `${userId}_${key}`,
        actor: { kind: 'user', userId },
      }),
    fund: async (minor: bigint, source = 'card') =>
      store.transaction(async (unit) => {
        await lockAll(unit.ledger, [earned(userId), SYSTEM.OPENING_EQUITY]);
        await postEntry(unit.ledger, {
          txnId: `txn_seed_${userId}_${++id}`,
          legs: [
            debit(SYSTEM.OPENING_EQUITY, amount(minor)),
            credit(earned(userId), amount(minor)),
          ],
          meta: { kind: 'seed', source },
        });
      }),
  };
}

// This independently folds every account's signed entries through the store port. The model
// below also keeps its own amounts; a bug shared by a cached balance and read() cannot pass both.
async function replayTotal(store: Store, userId: string): Promise<bigint> {
  let total = 0n;
  for await (const account of store.ledger.balanceAccounts()) {
    if (account !== earned(userId) && !account.startsWith(`${userId}:hold:`))
      continue;
    const derived = (await store.ledger.derivedBalances(account)).reduce(
      (sum, a) => sum + a.minor,
      0n,
    );
    assert.equal((await store.ledger.balance(account)).minor, derived);
    assert.ok(derived >= 0n, `negative account ${account}`);
    total += derived;
  }
  return total;
}

const program = array(
  record({
    kind: choice('hold', 'release', 'expire', 'advance', 'payout', 'retry'),
    minor: int(1, 400),
    slot: int(0, 12),
  }),
  40,
);
const PROGRAMS = 32;
const SEED = 0xb41a;
const RACES = 12;

type ModelHold = {
  holdId: string;
  remaining: bigint;
  expiresAt: number;
};

async function placeGeneratedHold(
  f: ReturnType<typeof fixture>,
  reserved: ModelHold[],
  step: { index: number; minor: bigint; available: bigint },
): Promise<void> {
  const input = {
    userId: f.userId,
    holdId: `hold_${step.index}`,
    amount: amount(step.minor),
    expiresAt: f.now() + 25,
    releaseEvent: 'done',
    now: f.now(),
  };
  if (step.minor <= step.available) {
    await f.holds.place(input);
    reserved.push({
      holdId: input.holdId,
      remaining: step.minor,
      expiresAt: input.expiresAt,
    });
  } else {
    await assert.rejects(f.holds.place(input), hasCode('LEDGER.OVERDRAFT'));
  }
}

async function releaseGeneratedHold(
  f: ReturnType<typeof fixture>,
  reserved: ModelHold[],
  step: { index: number; minor: bigint; slot: number },
): Promise<void> {
  if (reserved.length === 0) return;
  const h = reserved[step.slot % reserved.length]!;
  const input = {
    userId: f.userId,
    holdId: h.holdId,
    idempotencyKey: `part_${step.index}`,
    amount: amount(step.minor),
    event: 'done',
    now: f.now(),
  };
  if (step.minor <= h.remaining) {
    await f.holds.release(input);
    h.remaining -= step.minor;
  } else {
    await assert.rejects(
      f.holds.release(input),
      hasCode(h.remaining === 0n ? 'OP.MALFORMED' : 'LEDGER.OVERDRAFT'),
    );
  }
}

for (const adapter of adapterMatrix(process.env)) {
  let store: Store | undefined;
  let unavailable: string | undefined;
  try {
    store = await adapter.makeStore();
  } catch (error) {
    if (
      process.env.BALANCE_HOLDS_REQUIRE_STORES === '1' ||
      adapter.name === 'memory' ||
      adapter.name === 'http'
    )
      throw error;
    unavailable = `${adapter.name} unavailable: ${String(error)}`;
  }

  describe(`balance holds (${adapter.name})`, { skip: unavailable }, () => {
    after(async () => {
      await store?.close();
    });

    test('moves pending to available at the inclusive maturity boundary and keeps holds out of payouts', async () => {
      const f = fixture(store!);
      await f.fund(1_000n);
      const before = await f.holds.read({ userId: f.userId, now: 99 });
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(before).map(([k, v]) => [k, v.minor]),
        ),
        {
          pending: 1_000n,
          available: 0n,
          reserved: 0n,
          total: 1_000n,
        },
      );
      await assert.rejects(
        f.holds.place({
          userId: f.userId,
          holdId: 'delivery',
          amount: amount(1n),
          expiresAt: 200,
          now: 99,
        }),
        hasCode('LEDGER.OVERDRAFT'),
      );
      f.at(100);
      await f.holds.place({
        userId: f.userId,
        holdId: 'delivery',
        amount: amount(700n),
        expiresAt: 200,
        now: 100,
      });
      const held = await f.holds.read({ userId: f.userId, now: 100 });
      assert.equal(held.available.minor, 300n);
      assert.equal(held.reserved.minor, 700n);
      assert.equal(
        (await f.economy.submit(f.payout(301n, 'too_much'))).status,
        'rejected',
      );
      assert.equal(
        (await f.economy.submit(f.payout(300n, 'available'))).status,
        'committed',
      );
      const paid = await f.holds.read({ userId: f.userId, now: 100 });
      assert.equal(paid.total.minor, 700n);
      assert.equal(paid.available.minor, 0n);
      assert.equal(await replayTotal(store!, f.userId), 700n);
    });

    test('releases part on the matching event, replays retries, and expires only the remainder', async () => {
      const f = fixture(store!);
      await f.fund(1_000n, 'instant');
      const opening = {
        userId: f.userId,
        holdId: 'delivery',
        amount: amount(700n),
        releaseEvent: 'delivered',
        expiresAt: 100,
        now: 0,
      };
      const placed = await f.holds.place(opening);
      assert.equal(
        (await f.holds.place({ ...opening, now: 1 })).transactionId,
        placed.transactionId,
      );
      await assert.rejects(
        f.holds.place({ ...opening, amount: amount(701n) }),
        hasCode('OP.MALFORMED'),
      );
      const release = {
        userId: f.userId,
        holdId: 'delivery',
        idempotencyKey: 'part',
        amount: amount(200n),
        event: 'delivered',
        now: 10,
      };
      await assert.rejects(
        f.holds.release({ ...release, event: 'wrong' }),
        hasCode('OP.MALFORMED'),
      );
      await assert.rejects(
        f.holds.release({ ...release, event: undefined }),
        hasCode('OP.MALFORMED'),
      );
      const released = await f.holds.release(release);
      assert.equal(
        (await f.holds.release({ ...release, now: 20 })).transactionId,
        released.transactionId,
      );
      await assert.rejects(
        f.holds.release({ ...release, amount: amount(201n) }),
        hasCode('OP.MALFORMED'),
      );
      await assert.rejects(
        f.holds.release({
          ...release,
          idempotencyKey: 'over',
          amount: amount(501n),
        }),
        hasCode('LEDGER.OVERDRAFT'),
      );
      assert.equal(
        (await f.holds.expire({ userId: f.userId, now: 99 })).length,
        0,
      );
      assert.equal(
        (await f.holds.read({ userId: f.userId, now: 99 })).reserved.minor,
        500n,
      );
      assert.equal(
        (await f.holds.expire({ userId: f.userId, now: 100 })).length,
        1,
      );
      assert.equal(
        (await f.holds.expire({ userId: f.userId, now: 100 })).length,
        0,
      );
      const final = await f.holds.read({ userId: f.userId, now: 100 });
      assert.equal(final.available.minor, 1_000n);
      assert.equal(final.pending.minor, 0n);
      assert.equal(final.reserved.minor, 0n);
      assert.equal(await replayTotal(store!, f.userId), 1_000n);
    });

    test('case-distinct hold IDs reserve, release, and expire independently', async () => {
      const f = fixture(store!);
      await f.fund(1_000n, 'instant');
      const upper = await f.holds.place({
        userId: f.userId,
        holdId: 'Review',
        amount: amount(300n),
        releaseEvent: 'reviewed',
        expiresAt: 100,
        now: 0,
      });
      const lower = await f.holds.place({
        userId: f.userId,
        holdId: 'review',
        amount: amount(400n),
        releaseEvent: 'reviewed',
        expiresAt: 200,
        now: 0,
      });
      assert.equal(upper.status, 'committed');
      assert.equal(lower.status, 'committed');
      assert.notEqual(upper.transactionId, lower.transactionId);
      assert.deepEqual(await f.holds.read({ userId: f.userId, now: 0 }), {
        pending: amount(0n),
        available: amount(300n),
        reserved: amount(700n),
        total: amount(1_000n),
      });

      const released = await f.holds.release({
        userId: f.userId,
        holdId: 'Review',
        idempotencyKey: 'partial',
        amount: amount(100n),
        event: 'reviewed',
        now: 10,
      });
      assert.equal(released.amount.minor, 100n);
      assert.equal(
        (await store!.ledger.balance(balanceHoldAccount(f.userId, 'Review')))
          .minor,
        200n,
      );
      assert.equal(
        (await store!.ledger.balance(balanceHoldAccount(f.userId, 'review')))
          .minor,
        400n,
      );
      const firstExpiry = await f.holds.expire({ userId: f.userId, now: 100 });
      assert.deepEqual(
        firstExpiry.map((receipt) => receipt.amount.minor),
        [200n],
      );
      assert.deepEqual(await f.holds.read({ userId: f.userId, now: 100 }), {
        pending: amount(0n),
        available: amount(600n),
        reserved: amount(400n),
        total: amount(1_000n),
      });
      assert.equal(
        (await f.holds.expire({ userId: f.userId, now: 199 })).length,
        0,
      );
      const lastExpiry = await f.holds.expire({ userId: f.userId, now: 200 });
      assert.deepEqual(
        lastExpiry.map((receipt) => receipt.amount.minor),
        [400n],
      );
      assert.deepEqual(await f.holds.read({ userId: f.userId, now: 200 }), {
        pending: amount(0n),
        available: amount(1_000n),
        reserved: amount(0n),
        total: amount(1_000n),
      });
      assert.equal(await replayTotal(store!, f.userId), 1_000n);
    });

    test('case-distinct owners have separate balances and holds', async () => {
      const lower = fixture(store!);
      const upper = fixture(store!, lower.userId.toUpperCase());
      await lower.fund(1_000n, 'instant');
      assert.deepEqual(
        await upper.holds.read({ userId: upper.userId, now: 0 }),
        {
          pending: amount(0n),
          available: amount(0n),
          reserved: amount(0n),
          total: amount(0n),
        },
      );
      await upper.fund(500n, 'instant');
      for (const [f, minor, expiresAt] of [
        [lower, 300n, 100],
        [upper, 200n, 200],
      ] as const) {
        await f.holds.place({
          userId: f.userId,
          holdId: 'shared',
          amount: amount(minor),
          releaseEvent: 'done',
          expiresAt,
          now: 0,
        });
      }
      assert.deepEqual(
        await lower.holds.read({ userId: lower.userId, now: 0 }),
        {
          pending: amount(0n),
          available: amount(700n),
          reserved: amount(300n),
          total: amount(1_000n),
        },
      );
      const upperHeld = {
        pending: amount(0n),
        available: amount(300n),
        reserved: amount(200n),
        total: amount(500n),
      };
      assert.deepEqual(
        await upper.holds.read({ userId: upper.userId, now: 0 }),
        upperHeld,
      );
      const expired = await lower.holds.expire({
        userId: lower.userId,
        now: 100,
      });
      assert.deepEqual(
        expired.map((receipt) => receipt.amount.minor),
        [300n],
      );
      assert.deepEqual(
        await upper.holds.read({ userId: upper.userId, now: 100 }),
        upperHeld,
      );
      await upper.holds.release({
        userId: upper.userId,
        holdId: 'shared',
        idempotencyKey: 'release',
        event: 'done',
        now: 101,
      });
      for (const [f, minor] of [
        [lower, 1_000n],
        [upper, 500n],
      ] as const) {
        assert.deepEqual(await f.holds.read({ userId: f.userId, now: 101 }), {
          pending: amount(0n),
          available: amount(minor),
          reserved: amount(0n),
          total: amount(minor),
        });
        assert.equal(await replayTotal(store!, f.userId), minor);
      }
    });

    test('released matured funds are immediately payable without restarting the settlement wait', async () => {
      const f = fixture(store!);
      await f.fund(1_000n);
      f.at(100);
      await f.holds.place({
        userId: f.userId,
        holdId: 'event',
        amount: amount(1_000n),
        releaseEvent: 'done',
        now: 100,
      });
      await f.holds.release({
        userId: f.userId,
        holdId: 'event',
        event: 'done',
        now: 101,
        idempotencyKey: 'release',
      });
      f.at(101);
      assert.equal(
        (await f.holds.read({ userId: f.userId, now: 101 })).available.minor,
        1_000n,
      );
      assert.equal(
        (await f.economy.submit(f.payout(1_000n, 'released'))).status,
        'committed',
      );
    });

    test('holds and payouts cannot turn older pending funds into available funds', async () => {
      const f = fixture(store!);
      await f.fund(500n, 'card');
      await f.fund(500n, 'instant');
      await f.holds.place({
        userId: f.userId,
        holdId: 'mixed',
        amount: amount(300n),
        releaseEvent: 'done',
        now: 0,
      });
      let balance = await f.holds.read({ userId: f.userId, now: 0 });
      assert.equal(balance.pending.minor, 500n);
      assert.equal(balance.available.minor, 200n);
      assert.equal(
        (await f.economy.submit(f.payout(200n, 'mixed'))).status,
        'committed',
      );
      assert.equal(
        (await f.economy.submit(f.payout(1n, 'pending'))).status,
        'rejected',
      );
      await f.holds.release({
        userId: f.userId,
        holdId: 'mixed',
        idempotencyKey: 'released',
        event: 'done',
        now: 1,
      });
      f.at(1);
      balance = await f.holds.read({ userId: f.userId, now: 1 });
      assert.equal(balance.pending.minor, 500n);
      assert.equal(balance.available.minor, 300n);
      assert.equal(
        (await f.economy.submit(f.payout(300n, 'release'))).status,
        'committed',
      );
      assert.equal(
        (await f.economy.submit(f.payout(1n, 'still_pending'))).status,
        'rejected',
      );
      balance = await f.holds.read({ userId: f.userId, now: 100 });
      assert.equal(balance.pending.minor, 0n);
      assert.equal(balance.available.minor, 500n);
      assert.equal(await replayTotal(store!, f.userId), 500n);
    });

    test('keeps accrual debt as an additional gate without changing the ledger balance buckets', async () => {
      const f = fixture(store!);
      await f.fund(1_000n, 'instant');
      await store!.transaction(async (unit) => {
        await unit.accruals.put([
          {
            orderId: `order_${f.userId}`,
            sellerId: f.userId,
            seq: 0,
            amount: amount(-600n),
            shard: SYSTEM.SETTLEMENT_ACCRUAL,
            status: 'pending',
            txnId: `txn_debt_${f.userId}`,
            settledTxnId: null,
            recordedAt: 0,
          },
        ]);
      });
      assert.equal(
        (await f.holds.read({ userId: f.userId, now: 0 })).available.minor,
        1_000n,
      );
      await assert.rejects(
        f.holds.place({
          userId: f.userId,
          holdId: 'debt',
          amount: amount(401n),
          expiresAt: 10,
          now: 0,
        }),
        hasCode('LEDGER.OVERDRAFT'),
      );
      assert.equal(
        (await f.economy.submit(f.payout(401n, 'debt'))).status,
        'rejected',
      );
      await f.holds.place({
        userId: f.userId,
        holdId: 'debt',
        amount: amount(400n),
        expiresAt: 10,
        now: 0,
      });
      const balance = await f.holds.read({ userId: f.userId, now: 0 });
      assert.equal(balance.available.minor, 600n);
      assert.equal(balance.pending.minor, 0n);
      assert.equal(balance.reserved.minor, 400n);
      assert.equal(await replayTotal(store!, f.userId), 1_000n);
    });

    test('fails closed when a reserved balance loses its opening ledger entry', async () => {
      const f = fixture(store!);
      await f.fund(500n, 'instant');
      const opening = await f.holds.place({
        userId: f.userId,
        holdId: 'missing',
        amount: amount(500n),
        expiresAt: 10,
        now: 0,
      });
      const missingAnchor: Store = {
        ...store!,
        transaction: (work, options) =>
          store!.transaction(
            (unit) =>
              work({
                ...unit,
                ledger: {
                  ...unit.ledger,
                  posting: (id, opts) =>
                    id === opening.transactionId
                      ? Promise.resolve(null)
                      : unit.ledger.posting(id, opts),
                },
              }),
            options,
          ),
      };
      const holds = createBalanceHolds({
        store: missingAnchor,
        config,
        digest: seededDigest(1),
      });
      await assert.rejects(
        holds.read({ userId: f.userId, now: 10 }),
        hasCode('CHAIN.BROKEN'),
      );
      await assert.rejects(
        holds.expire({ userId: f.userId, now: 10 }),
        hasCode('CHAIN.BROKEN'),
      );
      assert.equal(
        (await f.holds.read({ userId: f.userId, now: 10 })).reserved.minor,
        500n,
      );
    });

    test('validates identifiers, positive CREDIT amounts, times, and release conditions before posting', async () => {
      const f = fixture(store!);
      await f.fund(1_000n, 'instant');
      const valid = {
        userId: f.userId,
        holdId: 'hold',
        amount: amount(100n),
        expiresAt: 100,
        now: 0,
      };
      for (const invalid of [
        { ...valid, userId: 'usr:other' },
        { ...valid, userId: 'platform' },
        { ...valid, holdId: 'a:reserved' },
        { ...valid, amount: amount(0n) },
        { ...valid, amount: amount(-1n) },
        { ...valid, amount: toAmount('USD', 1n) },
        { ...valid, now: Number.NaN },
        { ...valid, now: -1 },
        { ...valid, expiresAt: Number.POSITIVE_INFINITY },
        { ...valid, expiresAt: undefined },
      ]) {
        await assert.rejects(f.holds.place(invalid), hasCode('OP.MALFORMED'));
      }
      assert.equal(await replayTotal(store!, f.userId), 1_000n);
    });

    test('concurrent retries place one hold and release its money once', async () => {
      const f = fixture(store!);
      await f.fund(1_000n, 'instant');
      const opening = {
        userId: f.userId,
        holdId: 'same',
        amount: amount(1_000n),
        releaseEvent: 'done',
        now: 0,
      };
      const results = await Promise.all([
        f.holds.place(opening),
        f.holds.place(opening),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), [
        'committed',
        'duplicate',
      ]);
      const release = {
        userId: f.userId,
        holdId: 'same',
        idempotencyKey: 'once',
        event: 'done',
        now: 1,
      };
      const released = await Promise.all([
        f.holds.release(release),
        f.holds.release(release),
      ]);
      assert.deepEqual(released.map((r) => r.status).sort(), [
        'committed',
        'duplicate',
      ]);
      assert.equal(
        (await f.holds.read({ userId: f.userId, now: 1 })).available.minor,
        1_000n,
      );
      assert.equal(await replayTotal(store!, f.userId), 1_000n);
    });

    test(
      'two payout requests for the same funds commit exactly once',
      { timeout: 60_000 },
      async (t) => {
        let overlaps = 0;
        for (let i = 0; i < RACES; i += 1) {
          // SQL callbacks run after BEGIN on separate pooled connections. The barrier proves both
          // transactions entered before either requests a row lock. Memory serializes writers.
          let entered = 0;
          let transactionId = 0;
          const barrier = Promise.withResolvers<void>();
          const concurrentStore =
            adapter.name === 'postgres' || adapter.name === 'mysql'
              ? {
                  ...store!,
                  transaction: ((work, options) =>
                    store!.transaction(async (unit) => {
                      entered += 1;
                      if (entered === 2) {
                        overlaps += 1;
                        barrier.resolve();
                      }
                      if (entered <= 2) await barrier.promise;
                      return work(unit);
                    }, options)) as Store['transaction'],
                }
              : store!;
          const f = fixture(store!);
          await f.fund(1_000n, 'instant');
          const racing = createEconomy(
            makePorts(concurrentStore, {
              config,
              ids: { next: (p) => `${p}_race_${f.userId}_${++transactionId}` },
            }),
          );
          const outcomes = await Promise.all([
            racing.submit(f.payout(1_000n, 'a')),
            racing.submit(f.payout(1_000n, 'b')),
          ]);
          assert.deepEqual(outcomes.map((o) => o.status).sort(), [
            'committed',
            'rejected',
          ]);
          assert.equal(
            (await f.holds.read({ userId: f.userId, now: 0 })).total.minor,
            0n,
          );
          assert.equal(await replayTotal(store!, f.userId), 0n);
        }
        if (adapter.name === 'postgres' || adapter.name === 'mysql')
          assert.equal(overlaps, RACES);
        t.diagnostic(
          `${RACES} payout races; ${overlaps} pairs overlapped inside database transactions`,
        );
      },
    );

    test('concurrent payout retries replay one accepted transaction', async () => {
      const f = fixture(store!);
      await f.fund(1_000n, 'instant');
      const operation = f.payout(700n, 'once');
      const outcomes = await Promise.all([
        f.economy.submit(operation),
        f.economy.submit(operation),
      ]);
      assert.deepEqual(outcomes.map((o) => o.status).sort(), [
        'committed',
        'duplicate',
      ]);
      const ids = outcomes.map((o) =>
        o.status === 'rejected' ? null : o.transaction.id,
      );
      assert.equal(ids[0], ids[1]);
      assert.equal(
        (await f.holds.read({ userId: f.userId, now: 0 })).total.minor,
        300n,
      );
      assert.equal(await replayTotal(store!, f.userId), 300n);
    });

    test(
      'generated holds, releases, expirations and payouts preserve the reference balances after every step',
      { timeout: 180_000 },
      async (t) => {
        let executed = 0;
        let failure: unknown;
        const report = await check(
          program,
          async (steps) => {
            const f = fixture(store!);
            await f.fund(1_000n);
            let total = 1_000n;
            const reserved: ModelHold[] = [];
            let lastPayout: Operation | undefined;
            try {
              for (const [index, step] of steps.entries()) {
                executed += 1;
                const n = BigInt(step.minor);
                const held = reserved.reduce((sum, h) => sum + h.remaining, 0n);
                const available = f.now() >= 100 ? total - held : 0n;
                if (step.kind === 'advance') f.at(f.now() + (step.minor % 51));
                if (step.kind === 'hold') {
                  await placeGeneratedHold(f, reserved, {
                    index,
                    minor: n,
                    available,
                  });
                }
                if (step.kind === 'release') {
                  await releaseGeneratedHold(f, reserved, {
                    index,
                    minor: n,
                    slot: step.slot,
                  });
                }
                if (step.kind === 'expire') {
                  await f.holds.expire({ userId: f.userId, now: f.now() });
                  for (const h of reserved.filter(
                    (hold) => hold.expiresAt <= f.now(),
                  ))
                    h.remaining = 0n;
                }
                if (step.kind === 'payout') {
                  const op = f.payout(n, `payout_${index}`);
                  const outcome = await f.economy.submit(op);
                  assert.equal(
                    outcome.status,
                    n <= available ? 'committed' : 'rejected',
                  );
                  if (outcome.status === 'committed') {
                    total -= n;
                    lastPayout = op;
                  }
                }
                if (step.kind === 'retry' && lastPayout)
                  assert.equal(
                    (await f.economy.submit(lastPayout)).status,
                    'duplicate',
                  );
                const expectedReserved = reserved.reduce(
                  (sum, h) => sum + h.remaining,
                  0n,
                );
                const expectedAvailable =
                  f.now() >= 100 ? total - expectedReserved : 0n;
                const actual = await f.holds.read({
                  userId: f.userId,
                  now: f.now(),
                });
                assert.equal(actual.total.minor, total);
                assert.equal(actual.reserved.minor, expectedReserved);
                assert.equal(actual.available.minor, expectedAvailable);
                assert.equal(
                  actual.pending.minor,
                  total - expectedReserved - expectedAvailable,
                );
                assert.equal(
                  actual.pending.minor +
                    actual.available.minor +
                    actual.reserved.minor,
                  total,
                );
                assert.equal(await replayTotal(store!, f.userId), total);
              }
              return true;
            } catch (error) {
              failure = error;
              return false;
            }
          },
          { seed: SEED, runs: PROGRAMS },
        );
        assert.ok(
          report.ok,
          `seeded property failed: ${JSON.stringify(report)}; ${String(failure)}`,
        );
        t.diagnostic(
          `${PROGRAMS} programs from seed ${SEED}; ${executed} steps checked against an independent model and ledger replay`,
        );
      },
    );
  });
}
