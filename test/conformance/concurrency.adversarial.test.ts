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

/**
 * Concurrency safety — the gap the rest of the suite never covers (it submits one operation at a
 * time). Fire N parallel spends on one wallet funded for only K of them, against a live SQL engine,
 * and assert the engine never lets the wallet oversell: at most K commit, the balance never goes
 * negative, the cached balance equals `funded - committed`, and the ledger stays conserved.
 *
 * The losers may come back as a graceful `rejected` (the funds pre-check saw the wallet drained) or
 * as a thrown overdraft fault (two spends both cleared the pre-check, then the non-negative CHECK
 * refused the second at post time). Either is correct: no interleaving moves money that isn't there.
 * The non-negative CHECK is the real guard under concurrency, on top of the per-account locks the
 * write path takes. An unreachable engine skips (never fails), the same contract the other
 * conformance suites use.
 *
 * On top of that hand-built race, a model-based check fires randomized, oversubscribed batches and
 * proves the engine is linearizable: every spend it commits under concurrency must also commit when
 * the committed set is replayed serially on a fresh in-memory store (the executable model), and the
 * resulting balances must match it exactly. The in-memory store is the model, so the check can't
 * drift from the logic it checks. (See docs/the-next-step.md, item 3.)
 */

import { describe, test, before, after } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { makeEconomy } from '#test/support/economy.ts';
import { topUp, spend, credit } from '#test/support/builders.ts';
import { spendable, earned } from '#src/accounts.ts';
import { encodeAmount } from '#src/money.ts';
import {
  adversarialPostgres,
  adversarialMysql,
} from '#test/conformance/adversarial-engines.ts';

import type { AdversarialEngine } from '#test/conformance/adversarial-engines.ts';
import type { Economy, Operation, Outcome } from '#src/contract.ts';

let seq = 0;

// A reproducible PRNG (mulberry32) so each randomized batch replays identically across runs and
// engines — same seed, same workload everywhere. Matches scripts/prove.ts and scripts/fuzz.ts.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One deliberately oversubscribed batch: 1–2 buyers funded a few credits each, then exactly 4 spends
// scattered across them (price 1–3). Total demand routinely exceeds the funds, so the engine must
// reject some, and several spends landing on one wallet are the same-account race. Spends draw only
// spendable (no promo grant), so a committed set is admissible in any order, which is what lets a
// fresh in-memory replay stand in as the sequential model. 4 is the ceiling: each in-flight spend
// holds a transaction connection plus a velocity-record connection, so the batch stays under half
// the pool (see the oversell test's note).
function batch(
  rng: () => number,
  tag: string,
): {
  seller: string;
  buyers: string[];
  fundingOps: Operation[];
  spendOps: Operation[];
} {
  let seller = `usr_lin_seller_${tag}`;
  let buyers: string[] = [];
  let fundingOps: Operation[] = [];
  let buyerCount = 1 + Math.floor(rng() * 2);
  for (let b = 0; b < buyerCount; b += 1) {
    let buyer = `usr_lin_b${b}_${tag}`;
    buyers.push(buyer);
    let fund = 2 + Math.floor(rng() * 3);
    fundingOps.push(topUp({ userId: buyer, amount: credit(`${fund}.00`) }));
  }
  let spendOps = Array.from({ length: 4 }, () => {
    let buyer = buyers[Math.floor(rng() * buyers.length)]!;
    let price = 1 + Math.floor(rng() * 3);
    return spend({
      buyerId: buyer,
      sku: 'wrld_pass',
      price: credit(`${price}.00`),
      recipients: [{ sellerId: seller, shareBps: 10_000 }],
    });
  });
  return { seller, buyers, fundingOps, spendOps };
}

// The model-based linearizability check for one seed against one live engine. Fund sequentially,
// fire the spends concurrently and record which committed, then replay that committed set on a fresh
// in-memory store — the executable sequential model. The concurrent run is linearizable iff (a) every
// op it committed also commits in the serial replay (it never admitted a set no serial schedule
// allows), and (b) the resulting per-account balances match the model exactly (no lost update).
// prove() then confirms the engine's books still close. The in-memory store is the model, so the
// handler logic is never re-implemented, so the check can't drift from what it checks.
async function assertLinearizable(
  engine: Economy,
  seed: number,
  tag: string,
): Promise<void> {
  let { seller, buyers, fundingOps, spendOps } = batch(mulberry32(seed), tag);

  for (let op of fundingOps) {
    assert.equal((await engine.submit(op)).status, 'committed');
  }

  let committed: Operation[] = [];
  await Promise.all(
    spendOps.map((op) =>
      engine.submit(op).then(
        (o) => {
          if (o.status === 'committed') committed.push(op);
        },
        () => {}, // a thrown overdraft fault is simply "not committed"
      ),
    ),
  );

  let model = makeEconomy(1);
  try {
    for (let op of fundingOps) {
      assert.equal((await model.submit(op)).status, 'committed');
    }
    for (let op of committed) {
      assert.equal(
        (await model.submit(op)).status,
        'committed',
        `${tag}: the engine committed a spend the sequential model rejects — over-admitted under concurrency`,
      );
    }
    for (let buyer of buyers) {
      assert.equal(
        (await engine.read.balance(spendable(buyer))).minor,
        (await model.read.balance(spendable(buyer))).minor,
        `${tag}: ${buyer} spendable diverged from the sequential model`,
      );
    }
    assert.equal(
      (await engine.read.balance(earned(seller))).minor,
      (await model.read.balance(earned(seller))).minor,
      `${tag}: seller earned diverged from the sequential model`,
    );
    let report = await engine.read.prove();
    assert.ok(
      report.conserved,
      `${tag}: conservation broken under concurrency`,
    );
    assert.ok(report.noOverdraft, `${tag}: overdraft under concurrency`);
    assert.ok(
      report.consistent,
      `${tag}: cached balance drifted from the legs`,
    );
  } finally {
    await model.close();
  }
}

function runConcurrency(
  name: string,
  provision: () => Promise<AdversarialEngine | null>,
): void {
  describe(`Concurrency: ${name}`, () => {
    let engine: AdversarialEngine | null = null;

    before(async () => {
      engine = await provision();
    });
    after(async () => {
      if (engine) {
        await engine.close();
      }
    });

    test('N parallel same-account spends never oversell', async (t: TestContext) => {
      if (!engine) return t.skip(`${name} unreachable`);
      let economy = makeEconomy(1, engine.store);
      let buyer = `usr_conc_${name}_${(seq += 1)}`;

      // Fire 4 parallel 1.00 spends against a 2.00 wallet — at most 2 are affordable. Parallelism is
      // kept under half the connection pool on purpose: each in-flight spend holds its transaction
      // connection and briefly needs a second pool connection for the velocity record (trust.record
      // runs on the pool, outside the money transaction, so a rejected attempt still counts). Pushing
      // parallelism past pool/2 exhausts the pool and deadlocks — a real operational limit worth
      // sizing for, not a property of this safety check.
      let parallelism = 4;
      let affordable = 2;
      await economy.submit(topUp({ userId: buyer, amount: credit('2.00') }));
      let attempts = Array.from({ length: parallelism }, () =>
        spend({ buyerId: buyer, sku: 'wrld_pass', price: credit('1.00') }),
      );
      let settled = await Promise.allSettled(
        attempts.map((op) => economy.submit(op)),
      );

      let committed = settled.filter(
        (s): s is PromiseFulfilledResult<Outcome> =>
          s.status === 'fulfilled' && s.value.status === 'committed',
      ).length;

      // Safety, not liveness. No oversell:
      assert.ok(
        committed <= affordable,
        `oversold: ${committed} commits against a ${affordable}.00 balance`,
      );
      // Money is conserved across the race: the wallet holds exactly what wasn't spent, never < 0.
      let balance = await economy.read.balance(spendable(buyer));
      assert.equal(
        balance.minor,
        BigInt((affordable - committed) * 100),
        `balance ${encodeAmount(balance)} does not match ${committed} committed spends`,
      );
      assert.ok(
        balance.minor >= 0n,
        `wallet went negative: ${encodeAmount(balance)}`,
      );
      // And the whole ledger still proves out.
      let report = await economy.read.prove();
      assert.ok(report.conserved, 'conservation broken under concurrency');
      assert.ok(report.noOverdraft, 'overdraft under concurrency');
    });

    test('a randomized concurrent batch is linearizable to a sequential model', async (t: TestContext) => {
      // Its own freshly-provisioned engine, isolated from the oversell test's store above: a second
      // economy over a shared store would restart the seeded txn-id counter and collide on postings.
      let lin = await provision();
      if (!lin) return t.skip(`${name} unreachable`);
      try {
        // One economy across all seeds, so its generated txn ids stay unique; each seed gets its own
        // account namespace. A handful of seeds, each a different oversubscribed batch, replayed
        // identically every run.
        let economy = makeEconomy(1, lin.store);
        for (let seed of [0xc0ffee, 0xbeef, 0xf00d, 0xcafe, 0x1dea]) {
          await assertLinearizable(
            economy,
            seed,
            `${name}_${seed.toString(16)}`,
          );
        }
      } finally {
        await lin.close();
      }
    });
  });
}

runConcurrency('postgres', adversarialPostgres);
runConcurrency('mysql', adversarialMysql);
