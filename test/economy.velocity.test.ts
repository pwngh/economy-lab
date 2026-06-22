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

// The per-spend price, equal to the velocity ceiling below: exactly one spend at this price fits
// inside the rolling window before the limit is reached.
const PRICE_MINOR = 400n;

const N = 5;

// Build an economy whose velocity ceiling is one spend's price, and fund the buyer far above it
// WITHOUT touching the velocity window. Funding goes through an operator `adjust` (which credits
// the buyer's spendable directly and is NOT a velocity-tracked subject — see `riskSubject`), so
// the only thing that ever lands in the window is the spends the test fires. With the ceiling set
// to one price, the first spend brings the window to exactly the limit (allowed) and any further
// spend would push it over (denied).
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

// One spend priced exactly at the ceiling, with its own order id (so no two collide as a duplicate
// order) and — via the builder — its own fresh idempotency key (so each is a distinct attempt).
function spendAtLimit(orderId: string): ReturnType<typeof spend> {
  return spend({
    buyerId: 'usr_buyer',
    sku: 'wrld_pass',
    price: credit('4.00'),
    recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
    orderId,
  });
}

// How many of a batch of outcomes committed, and how many were rejected specifically for risk.
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

// One attempt at the ceiling price, with its own idempotency key so each counts as distinct.
function attemptAtLimit(i: number): Attempt {
  return {
    idempotencyKey: `velocity_attempt_${i}`,
    amount: toAmount('CREDIT', PRICE_MINOR),
    at: 0,
    outcome: 'committed',
  };
}

describe('Velocity limit under concurrency', () => {
  // The regression lock for the velocity-limit TOCTOU, exercised at the exact primitive the fix
  // introduced: the trust store's atomic record-and-measure (`trust.record`). N attempts for the
  // SAME subject, each at the ceiling price, are fired at once via Promise.all. Because each call
  // records its attempt AND reads back the windowed total in one indivisible, per-subject step, no
  // two can both read the same pre-record total: the returned totals come back strictly stepped
  // (one ceiling apart), so exactly ONE is at-or-below the limit and the rest are already over it.
  //
  // This is precisely what the screenRisk gate now does on every submit, so a same-subject burst
  // can no longer slip past `velocityLimitMinor` by any multiple. With the OLD split of a separate
  // `read` (inside the money transaction) and a deferred `bump` (after commit), each concurrent
  // attempt read the same stale total of zero and all N would have passed — the limit bypassed by a
  // factor of N. The contrast is asserted directly below. JS microtask interleaving makes both
  // outcomes deterministic and repeatable on the memory adapter.
  test('exactly one of N concurrent same-subject attempts stays within the limit', async () => {
    let store = memoryStore();

    let velocities = await Promise.all(
      Array.from({ length: N }, (_unused, i) =>
        store.trust.record('usr_buyer', attemptAtLimit(i)),
      ),
    );
    let totals = velocities.map((v) => v.spent.minor);

    // The atomic record-and-measure returns N distinct totals, one ceiling apart, so exactly one is
    // within the limit — the rolling ceiling is NOT exceeded by the burst.
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

  // The contrast: the OLD design's separate read-then-bump. Firing the same N reads concurrently
  // BEFORE any bump lands lets every one read the same stale zero, so every attempt would have been
  // judged within the limit — the TOCTOU the fix closes. This pins down that the bug was real and
  // that `record` (not `read`) is what makes the difference.
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

  // End-to-end sanity that the ceiling holds through the full submit pipeline the normal,
  // non-concurrent way: firing N spends one at a time (awaiting each) yields exactly one commit and
  // the rest risk-denied. The memory adapter serializes money transactions (one in-memory
  // transaction at a time), so the submit-level concurrency burst lives at the trust layer above;
  // this sequential pass guards the steady-state rule the gate enforces on every request.
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
});
