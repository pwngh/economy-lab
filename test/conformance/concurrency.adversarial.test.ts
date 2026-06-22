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
 * time). Fire N parallel spends on ONE wallet funded for only K of them, against a LIVE SQL engine,
 * and assert the engine never lets the wallet oversell: at most K commit, the balance never goes
 * negative, the cached balance equals exactly `funded - committed`, and the ledger stays conserved.
 *
 * The losers may come back as a graceful `rejected` (the funds pre-check saw the wallet drained) OR
 * as a thrown overdraft fault (two spends both cleared the pre-check, then the non-negative CHECK
 * refused the second at post time). Either is correct — what matters is that no interleaving moves
 * money that isn't there. The non-negative CHECK is the real guard under concurrency, on top of
 * the per-account locks the write path takes. An unreachable engine skips (never fails), the same
 * contract the other conformance suites use.
 */

import { describe, test, before, after } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { makeEconomy } from '#test/support/economy.ts';
import { topUp, spend, credit } from '#test/support/builders.ts';
import { spendable } from '#src/accounts.ts';
import { encodeAmount } from '#src/money.ts';
import {
  adversarialPostgres,
  adversarialMysql,
} from '#test/conformance/adversarial-engines.ts';

import type { AdversarialEngine } from '#test/conformance/adversarial-engines.ts';
import type { Outcome } from '#src/contract.ts';

let seq = 0;

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
      // kept under half the connection pool ON PURPOSE: each in-flight spend holds its transaction
      // connection AND briefly needs a second pool connection for the velocity record (trust.record
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
  });
}

runConcurrency('postgres', adversarialPostgres);
runConcurrency('mysql', adversarialMysql);
