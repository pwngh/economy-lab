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

// Equals the velocity ceiling below, so exactly one spend at this price fits the rolling window.
const PRICE_MINOR = 400n;

const N = 5;

// Funds the buyer far above the ceiling via an operator `adjust`, which is not a velocity-tracked
// subject (see `riskSubject`) — only the test's spends land in the window.
async function fundedEconomyAtLimit(): Promise<Economy> {
  const economy = makeEconomy(1, undefined, {
    velocityLimitMinor: PRICE_MINOR,
  });
  const funded = await economy.submit(
    adjust({
      account: spendable('usr_buyer'),
      amount: credit('100.00'),
      reason: 'fund buyer for velocity test',
    }),
  );
  assert.equal(funded.status, 'committed');
  return economy;
}

// A distinct order id and a fresh idempotency key keep each spend a distinct attempt.
function spendAtLimit(orderId: string): ReturnType<typeof spend> {
  return spend({
    buyerId: 'usr_buyer',
    sku: 'wrld_pass',
    price: credit('4.00'),
    recipients: [{ sellerId: 'usr_seller', shareBps: 10_000 }],
    orderId,
  });
}

function tally(outcomes: ReadonlyArray<Outcome>): {
  committed: number;
  riskDenied: number;
} {
  let committed = 0;
  let riskDenied = 0;
  for (const outcome of outcomes) {
    if (outcome.status === 'committed') {
      committed += 1;
    } else if (
      outcome.status === 'rejected' &&
      outcome.detail.reason === 'RISK_DENIED'
    ) {
      riskDenied += 1;
    }
  }
  return { committed, riskDenied };
}

function reasonOf(outcome: Outcome): string | undefined {
  return outcome.status === 'rejected' ? outcome.detail.reason : undefined;
}

function attemptAtLimit(i: number): Attempt {
  return {
    idempotencyKey: `velocity_attempt_${i}`,
    amount: toAmount('CREDIT', PRICE_MINOR),
    at: 0,
    outcome: 'committed',
  };
}

describe('Velocity limit under concurrency', () => {
  // Regression lock for the velocity-limit TOCTOU: `trust.record` records the attempt and reads
  // back the windowed total in one indivisible per-subject step, so concurrent same-subject calls
  // see strictly stepped totals. JS microtask interleaving makes this deterministic on memory.
  test('exactly one of N concurrent same-subject attempts stays within the limit', async () => {
    const store = memoryStore();

    const velocities = await Promise.all(
      Array.from({ length: N }, (_unused, i) =>
        store.trust.record('usr_buyer', attemptAtLimit(i)),
      ),
    );
    const totals = velocities.map((v) => v.spent.minor);

    const withinLimit = totals.filter((t) => t <= PRICE_MINOR).length;
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

  test('the old read-then-bump pattern would let every concurrent attempt pass', async () => {
    const store = memoryStore();

    const velocities = await Promise.all(
      Array.from({ length: N }, () => store.trust.read('usr_buyer')),
    );
    const withinLimit = velocities.filter(
      (v) => v.spent.minor <= PRICE_MINOR,
    ).length;
    assert.equal(
      withinLimit,
      N,
      'a bare concurrent read sees zero for all — the bypass the atomic record prevents',
    );

    await store.close();
  });

  // The memory adapter serializes money transactions, so this end-to-end pass is sequential; the
  // concurrent burst is exercised at the trust primitive above.
  test('exactly one of N sequential same-subject spends commits', async () => {
    const economy = await fundedEconomyAtLimit();

    const outcomes: Outcome[] = [];
    for (let i = 0; i < N; i += 1) {
      outcomes.push(
        await economy.submit(spendAtLimit(`ord_velocity_sequential_${i}`)),
      );
    }

    const { committed, riskDenied } = tally(outcomes);
    assert.equal(committed, 1, 'exactly one sequential spend may commit');
    assert.equal(riskDenied, N - 1, 'the rest must be turned away for risk');
  });

  // screenRisk records the attempt before screenFunds, so spends turned away for funds still
  // accrue velocity — a broke attacker cannot hammer forever without raising a flag.
  test('unaffordable spends still accrue velocity, so a burst is risk-denied not just under-funded', async () => {
    const economy = makeEconomy(1, undefined, {
      velocityLimitMinor: PRICE_MINOR,
    });
    // The buyer is never funded, so every spend fails the funds check on its own.
    const first = await economy.submit(spendAtLimit('ord_velocity_broke_1'));
    const second = await economy.submit(spendAtLimit('ord_velocity_broke_2'));

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
    // The refusal names the window class that tripped and its ceiling.
    const detail = (second as Extract<Outcome, { status: 'rejected' }>).detail;
    if (detail.reason !== 'RISK_DENIED') throw new Error('unreachable');
    assert.equal(detail.window, 'outflow');
    assert.equal(detail.limitMinor, PRICE_MINOR);

    await economy.close();
  });
});
