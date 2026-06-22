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

// Per-spend price, equal to the velocity ceiling below. One spend at this price fits inside the
// rolling window before the limit is reached.
const PRICE_MINOR = 400n;

const N = 5;

// Velocity ceiling is one spend's price; fund the buyer far above it without touching the velocity
// window. Funding goes through an operator `adjust` (credits the buyer's spendable directly, not a
// velocity-tracked subject, see `riskSubject`), so only the test's spends land in the window. The
// first spend brings the window to exactly the limit (allowed); any further spend pushes it over
// (denied).
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

// One spend at the ceiling price, with its own order id (no duplicate-order collision) and, via
// the builder, a fresh idempotency key (each is a distinct attempt).
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
  // Regression lock for the velocity-limit TOCTOU, at the primitive the fix introduced: the trust
  // store's atomic record-and-measure (`trust.record`). N attempts for the same subject, each at the
  // ceiling price, fire at once via Promise.all. Each call records its attempt and reads back the
  // windowed total in one indivisible per-subject step, so no two read the same pre-record total:
  // returned totals come back strictly stepped (one ceiling apart), one at-or-below the limit and
  // the rest over it.
  //
  // This is what the screenRisk gate now does on every submit, so a same-subject burst can no longer
  // slip past `velocityLimitMinor`. The old split of a separate `read` (inside the money
  // transaction) and a deferred `bump` (after commit) let each concurrent attempt read the same
  // stale zero, so all N passed (limit bypassed by a factor of N); contrast asserted below. JS
  // microtask interleaving makes both outcomes deterministic and repeatable on the memory adapter.
  test('exactly one of N concurrent same-subject attempts stays within the limit', async () => {
    let store = memoryStore();

    let velocities = await Promise.all(
      Array.from({ length: N }, (_unused, i) =>
        store.trust.record('usr_buyer', attemptAtLimit(i)),
      ),
    );
    let totals = velocities.map((v) => v.spent.minor);

    // Atomic record-and-measure returns N distinct totals one ceiling apart, so one is within the
    // limit; the rolling ceiling is not exceeded by the burst.
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

  // Contrast: the old design's separate read-then-bump. N concurrent reads before any bump lands all
  // see the same stale zero, so every attempt is judged within the limit, the TOCTOU the fix closes.
  // Pins down that the bug was real and that `record` (not `read`) makes the difference.
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

  // End-to-end sanity that the ceiling holds through the full submit pipeline non-concurrently: N
  // spends one at a time (awaiting each) yields one commit and the rest risk-denied. The memory
  // adapter serializes money transactions (one in-memory transaction at a time), so the
  // submit-level concurrency burst lives at the trust layer above; this sequential pass guards the
  // steady-state rule the gate enforces on every request.
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
