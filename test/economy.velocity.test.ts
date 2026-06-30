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

import { makeEconomy } from '#test/support/economy.ts';
import { adjust, spend, credit } from '#test/support/builders.ts';
import { spendable } from '#src/accounts.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import { toAmount } from '#src/money.ts';

import type { Economy } from '#src/economy.ts';
import type { Outcome } from '#src/contract.ts';
import type { Attempt } from '#src/ports.ts';

// The per-spend price. It equals the velocity ceiling below, so exactly one spend at this price
// fits inside the rolling window before the limit is reached.
const PRICE_MINOR = 400n;

const N = 5;

// Builds an economy whose buyer is funded far above the velocity ceiling, which is set to one
// spend's price. The funding goes through an operator `adjust` rather than a spend. The `adjust`
// credits the buyer's spendable directly, not a velocity-tracked subject (see `riskSubject`), so it
// never touches the velocity window and only the test's spends land there. Once funded, the first
// spend brings the window to exactly the limit and is allowed, and any further spend pushes it over
// and is denied.
async function fundedEconomyAtLimit(): Promise<Economy> {
  let economy = makeEconomy(1, undefined, { velocityLimitMinor: PRICE_MINOR });
  let funded = await economy.submit(
    adjust({
      account: spendable('usr_buyer'),
      amount: credit('100.00'),
      reason: 'fund buyer for velocity test',
    }),
  );
  assert.equal(funded.status, 'committed');
  return economy;
}

// Builds one spend at the ceiling price. Each gets its own order id so spends never collide as
// duplicate orders, and the builder gives each a fresh idempotency key so each counts as a distinct
// attempt.
function spendAtLimit(orderId: string): ReturnType<typeof spend> {
  return spend({
    buyerId: 'usr_buyer',
    sku: 'wrld_pass',
    price: credit('4.00'),
    recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
    orderId,
  });
}

// Counts how many of a batch of outcomes committed and how many were rejected specifically for risk.
function tally(outcomes: ReadonlyArray<Outcome>): {
  committed: number;
  riskDenied: number;
} {
  let committed = 0;
  let riskDenied = 0;
  for (let outcome of outcomes) {
    if (outcome.status === 'committed') {
      committed += 1;
    } else if (
      outcome.status === 'rejected' &&
      outcome.reason === 'RISK_DENIED'
    ) {
      riskDenied += 1;
    }
  }
  return { committed, riskDenied };
}

// Returns an outcome's rejection reason, or undefined if it committed or duplicated.
function reasonOf(outcome: Outcome): string | undefined {
  return outcome.status === 'rejected' ? outcome.reason : undefined;
}

// Builds one attempt at the ceiling price. Each gets its own idempotency key so each counts as
// distinct.
function attemptAtLimit(i: number): Attempt {
  return {
    idempotencyKey: `velocity_attempt_${i}`,
    amount: toAmount('CREDIT', PRICE_MINOR),
    at: 0,
    outcome: 'committed',
  };
}

describe('Velocity limit under concurrency', () => {
  // Regression lock for the velocity-limit TOCTOU, tested at the primitive the fix introduced: the
  // trust store's atomic record-and-measure (`trust.record`). N attempts for the same subject, each
  // at the ceiling price, fire at once via Promise.all. Each call records its attempt and reads back
  // the windowed total in one indivisible per-subject step. No two calls read the same pre-record
  // total, so the returned totals come back strictly stepped one ceiling apart, with one at or below
  // the limit and the rest over it.
  //
  // This is what the screenRisk gate now does on every submit, so a same-subject burst can no longer
  // slip past `velocityLimitMinor`. The old design split the check into a separate `read` inside the
  // money transaction and a deferred `bump` after commit. That let every concurrent attempt read the
  // same stale zero, so all N passed and the limit was bypassed by a factor of N (the contrast test
  // below asserts this). JS microtask interleaving makes both outcomes deterministic and repeatable
  // on the memory adapter.
  test('exactly one of N concurrent same-subject attempts stays within the limit', async () => {
    let store = memoryStore();

    let velocities = await Promise.all(
      Array.from({ length: N }, (_unused, i) =>
        store.trust.record('usr_buyer', attemptAtLimit(i)),
      ),
    );
    let totals = velocities.map((v) => v.spent.minor);

    // Atomic record-and-measure returns N distinct totals one ceiling apart, so exactly one is
    // within the limit. The burst does not exceed the rolling ceiling.
    let withinLimit = totals.filter((t) => t <= PRICE_MINOR).length;
    assert.equal(
      withinLimit,
      1,
      'exactly one concurrent attempt may stay within the ceiling',
    );
    assert.deepEqual(
      [...totals].sort((a, b) => Number(a - b)),
      [400n, 800n, 1200n, 1600n, 2000n],
      'each concurrent record sees a total that already includes the earlier ones',
    );

    await store.close();
  });

  // Contrast test for the old design's separate read-then-bump. N concurrent reads land before any
  // bump, so they all see the same stale zero and every attempt is judged within the limit. That is
  // the TOCTOU the fix closes. This test pins down that the bug was real and that `record`, not
  // `read`, makes the difference.
  test('the old read-then-bump pattern would let every concurrent attempt pass', async () => {
    let store = memoryStore();

    let velocities = await Promise.all(
      Array.from({ length: N }, () => store.trust.read('usr_buyer')),
    );
    let withinLimit = velocities.filter(
      (v) => v.spent.minor <= PRICE_MINOR,
    ).length;
    assert.equal(
      withinLimit,
      N,
      'a bare concurrent read sees zero for all — the bypass the atomic record prevents',
    );

    await store.close();
  });

  // End-to-end sanity check that the ceiling holds through the full submit pipeline without
  // concurrency. Submitting N spends one at a time, awaiting each, yields one commit and the rest
  // risk-denied. The memory adapter serializes money transactions, running one in-memory transaction
  // at a time, so the submit-level concurrency burst lives at the trust layer above. This sequential
  // pass guards the steady-state rule the gate enforces on every request.
  test('exactly one of N sequential same-subject spends commits', async () => {
    let economy = await fundedEconomyAtLimit();

    let outcomes: Outcome[] = [];
    for (let i = 0; i < N; i += 1) {
      outcomes.push(
        await economy.submit(spendAtLimit(`ord_velocity_sequential_${i}`)),
      );
    }

    let { committed, riskDenied } = tally(outcomes);
    assert.equal(committed, 1, 'exactly one sequential spend may commit');
    assert.equal(riskDenied, N - 1, 'the rest must be turned away for risk');
  });

  // Velocity is a fraud signal that must count even for denied attempts (README). screenRisk records
  // the attempt at check time, before screenFunds, so a burst of unaffordable spends still accrues
  // velocity. The first spend is turned away for funds, but its attempt is recorded and the window
  // now sits at the ceiling, so the second spend trips RISK_DENIED. Under the old funds-first order
  // the unaffordable attempts recorded nothing and the second was just another INSUFFICIENT_FUNDS,
  // so a broke attacker could hammer forever and never raise a flag.
  test('unaffordable spends still accrue velocity, so a burst is risk-denied not just under-funded', async () => {
    let economy = makeEconomy(1, undefined, {
      velocityLimitMinor: PRICE_MINOR,
    });
    // The buyer is never funded, so every spend fails the funds check on its own.
    let first = await economy.submit(spendAtLimit('ord_velocity_broke_1'));
    let second = await economy.submit(spendAtLimit('ord_velocity_broke_2'));

    assert.equal(
      reasonOf(first),
      'INSUFFICIENT_FUNDS',
      'the first unaffordable spend is turned away for funds — but its attempt is still recorded',
    );
    assert.equal(
      reasonOf(second),
      'RISK_DENIED',
      'the second trips velocity: the first unaffordable attempt counted toward the window',
    );

    await economy.close();
  });
});
