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

import {
  assessRisk,
  attemptMinor,
  riskAttempt,
  riskSubject,
  windowedVelocity,
} from '#src/trust.ts';
import { toAmount } from '#src/money.ts';
import { memoryStore } from '#src/adapters/memory.ts';
import {
  credit,
  emptyVelocity,
  grantPromo,
  requestPayout,
  spend,
  topUp,
} from '#test/support/builders.ts';
import { testConfig } from '#test/support/capabilities.ts';

import type { Operation, Outcome, Transaction } from '#src/contract.ts';
import type { Attempt, Velocity } from '#src/ports.ts';

// Build a config with a small spending limit so each test spells out the exact limit it
// is checking against, instead of relying on the larger default limit. `limitMinor` is
// the limit in CREDIT minor units (the smallest CREDIT unit, like cents for dollars), and
// `windowMs` is how long the spending window lasts in milliseconds.
function gateConfig(limitMinor: bigint, windowMs = 3_600_000) {
  return {
    ...testConfig(),
    velocityLimitMinor: limitMinor,
    velocityWindowMs: windowMs,
  };
}

// Build a spending record for one subject whose time window is currently open: it began at
// `windowStart` and has `spentMinor` spent so far (in CREDIT minor units, the smallest
// CREDIT unit). This is the shape the risk check receives once the store has brought the
// record up to date for the current time.
function velocityAt(windowStart: number, spentMinor: bigint): Velocity {
  return {
    subject: 'usr_buyer',
    windowStart,
    spent: toAmount('CREDIT', spentMinor),
    attempts: 1,
  };
}

// An operation that finished but was turned down by the risk check. A denied attempt must
// still be recorded toward the spending limit, so this is the outcome those tests use.
let REJECTED: Outcome = { status: 'rejected', reason: 'RISK_DENIED' };

// Build an outcome that carries a transaction. The transaction's contents don't matter
// here: the attempt builder only looks at the outcome's status and the operation's key, so
// the detail fields are left empty (legs are the debit/credit lines that moved money, and
// links are the per-account hash-chain entries).
function withTransaction(status: 'committed' | 'duplicate'): Outcome {
  let transaction: Transaction = {
    id: 'txn_test',
    postedAt: 0,
    legs: [],
    links: [],
  };
  return { status, transaction };
}

// --- assessRisk: deciding whether to allow an operation ----------------------------

function allowsWhenProjectedUnderCeiling(): void {
  let velocity = velocityAt(0, 600n); // 600 minor units = 6.00 already spent this window
  let operation = spend({
    buyerId: 'usr_buyer',
    sku: 'wrld_pass',
    price: credit('3.00'),
  });

  let decision = assessRisk(velocity, operation, gateConfig(1_000n));

  assert.deepEqual(decision, { allow: true });
}

function deniesWithRiskDeniedWhenProjectedOverCeiling(): void {
  let velocity = velocityAt(0, 800n); // 800 minor units = 8.00 already spent this window
  let operation = spend({
    buyerId: 'usr_buyer',
    sku: 'wrld_pass',
    price: credit('3.00'),
  });

  let decision = assessRisk(velocity, operation, gateConfig(1_000n));

  assert.deepEqual(decision, { allow: false, reason: 'RISK_DENIED' });
}

function allowsAtExactlyTheCeiling(): void {
  let velocity = velocityAt(0, 700n);
  let operation = spend({
    buyerId: 'usr_buyer',
    sku: 'wrld_pass',
    price: credit('3.00'),
  });

  // 7.00 already spent plus 3.00 lands exactly on the 10.00 limit. The check only denies
  // when the total goes strictly over the limit, so landing right on it is still allowed.
  let decision = assessRisk(velocity, operation, gateConfig(1_000n));

  assert.deepEqual(decision, { allow: true });
}

function allowsAnOperationOutsideTheRiskSurface(): void {
  let velocity = velocityAt(0, 1_000_000n); // a spend total far past any limit
  let operation: Operation = {
    // cancelSubscription moves no money, so the risk check never applies to it.
    kind: 'cancelSubscription',
    idempotencyKey: 'idem_cancel',
    actor: { kind: 'system', service: 'test' },
    subscriptionId: 'sub_1',
  };

  let decision = assessRisk(velocity, operation, gateConfig(1n));

  assert.deepEqual(decision, { allow: true });
}

// --- The spending window: windowedVelocity (a sliding window) -----------------------
// The window slides with the clock. `windowedVelocity` sums only the attempts whose time `at`
// is within the last `windowMs` of now (`at > now - windowMs`); older attempts age out one at a
// time on their own, rather than the whole total snapping back to zero at a fixed boundary.

function readsAnEmptyWindowForAFreshSubject(): void {
  // No attempts at all — a subject we've never tracked reads as nothing spent.
  let velocity = windowedVelocity('usr_new', [], 5_000, 3_600_000);

  assert.deepEqual(velocity, emptyVelocity('usr_new'));
}

function sumsAttemptsInsideTheWindow(): void {
  let attempts: Attempt[] = [
    {
      idempotencyKey: 'a1',
      amount: credit('5.00'),
      at: 1_000,
      outcome: 'rejected',
    },
    {
      idempotencyKey: 'a2',
      amount: credit('3.00'),
      at: 2_000,
      outcome: 'committed',
    },
  ];

  // now (2_500) is within an hour of both attempts, so both count toward the total. windowStart
  // comes back as the earliest `at` still in the window.
  let velocity = windowedVelocity('usr_buyer', attempts, 2_500, 3_600_000);

  assert.deepEqual(velocity, {
    subject: 'usr_buyer',
    windowStart: 1_000,
    spent: credit('8.00'),
    attempts: 2,
  });
}

function dropsAttemptsOlderThanTheWindow(): void {
  let attempts: Attempt[] = [
    {
      idempotencyKey: 'old',
      amount: credit('5.00'),
      at: 1_000,
      outcome: 'rejected',
    },
    {
      idempotencyKey: 'new',
      amount: credit('3.00'),
      at: 1_000 + 3_600_000,
      outcome: 'committed',
    },
  ];

  // Read exactly one window after the first attempt: its `at` (1_000) equals the cutoff
  // (now - windowMs), and the cutoff is exclusive (`at > cutoff`), so it ages out. Only the
  // second attempt remains.
  let now = 1_000 + 3_600_000;
  let velocity = windowedVelocity('usr_buyer', attempts, now, 3_600_000);

  assert.deepEqual(velocity, {
    subject: 'usr_buyer',
    windowStart: now,
    spent: credit('3.00'),
    attempts: 1,
  });
}

function agesAttemptsOutOneAtATimeAsTheWindowSlides(): void {
  let attempts: Attempt[] = [
    {
      idempotencyKey: 'a1',
      amount: credit('5.00'),
      at: 1_000,
      outcome: 'rejected',
    },
    {
      idempotencyKey: 'a2',
      amount: credit('4.00'),
      at: 1_800_000, // half a window after the first
      outcome: 'rejected',
    },
  ];

  // Read at a moment when the first attempt has just aged out but the second is still inside the
  // window. The total reflects only the second — proving attempts drop individually as the window
  // slides, NOT all at once at a fixed reset boundary (which would zero both).
  let now = 1_000 + 3_600_001;
  let velocity = windowedVelocity('usr_buyer', attempts, now, 3_600_000);

  assert.deepEqual(velocity, {
    subject: 'usr_buyer',
    windowStart: 1_800_000,
    spent: credit('4.00'),
    attempts: 1,
  });
}

// --- riskAttempt: building the record added to the spending total after an operation runs

function buildsARejectedAttemptKeyedOnTheOperationKey(): void {
  let operation = spend({
    buyerId: 'usr_buyer',
    sku: 'wrld_pass',
    price: credit('4.00'),
  });

  // A denied operation still gets recorded: many declines in a row is itself a fraud signal,
  // so each one counts toward the spending limit. The record is keyed on the operation's
  // idempotency key (the value that identifies a retried request) so a true retry of this
  // same request won't be counted twice.
  let attempt = riskAttempt(operation, REJECTED, 9_000);

  assert.deepEqual(attempt, {
    idempotencyKey: operation.idempotencyKey,
    amount: credit('4.00'),
    at: 9_000,
    outcome: 'rejected',
  });
}

function buildsACommittedAttemptFromASettledOperation(): void {
  let operation = topUp({ userId: 'usr_buyer', amount: credit('5.00') });

  let attempt = riskAttempt(operation, withTransaction('committed'), 12_000);

  assert.deepEqual(attempt, {
    idempotencyKey: operation.idempotencyKey,
    amount: credit('5.00'),
    at: 12_000,
    outcome: 'committed',
  });
}

function recordsNoAttemptForADuplicate(): void {
  let operation = spend({
    buyerId: 'usr_buyer',
    sku: 'wrld_pass',
    price: credit('4.00'),
  });

  // A duplicate outcome means this request already ran once and was counted then. Replaying
  // it must not add a second record, so the builder returns null.
  let attempt = riskAttempt(operation, withTransaction('duplicate'), 9_000);

  assert.equal(attempt, null);
}

function recordsNoAttemptOutsideTheRiskSurface(): void {
  let operation: Operation = {
    // cancelSubscription moves no money, so there is nothing to record toward the limit.
    kind: 'cancelSubscription',
    idempotencyKey: 'idem_cancel',
    actor: { kind: 'system', service: 'test' },
    subscriptionId: 'sub_1',
  };

  let attempt = riskAttempt(operation, withTransaction('committed'), 9_000);

  assert.equal(attempt, null);
}

// --- Picking the subject and size of an attempt: riskSubject + attemptMinor --------
// riskSubject returns the user whose spending total an operation counts against (or null
// when the operation moves no money). attemptMinor returns how much that operation adds to
// the total, in CREDIT minor units (the smallest CREDIT unit, like cents for dollars).

function keysFundsMovingOperationsOnTheirSubject(): void {
  let cases: ReadonlyArray<{
    operation: Operation;
    subject: string | null;
    minor: bigint;
  }> = [
    {
      operation: spend({ buyerId: 'usr_b', sku: 's', price: credit('2.00') }),
      subject: 'usr_b',
      minor: 200n,
    },
    {
      operation: topUp({ userId: 'usr_t', amount: credit('5.00') }),
      subject: 'usr_t',
      minor: 500n,
    },
    {
      operation: grantPromo({ userId: 'usr_g', amount: credit('1.00') }),
      subject: 'usr_g',
      minor: 100n,
    },
    {
      operation: requestPayout({ userId: 'usr_p', amount: credit('7.00') }),
      subject: 'usr_p',
      minor: 700n,
    },
  ];

  for (let { operation, subject, minor } of cases) {
    assert.equal(riskSubject(operation), subject);
    assert.equal(attemptMinor(operation), minor);
  }
}

function keysNoSubjectForNonFundsOperations(): void {
  let cases: ReadonlyArray<Operation> = [
    {
      kind: 'cancelSubscription',
      idempotencyKey: 'k1',
      actor: { kind: 'system', service: 't' },
      subscriptionId: 'sub_1',
    },
    {
      kind: 'revokeEntitlement',
      idempotencyKey: 'k2',
      actor: { kind: 'system', service: 't' },
      userId: 'usr_x',
      sku: 's',
    },
  ];

  for (let operation of cases) {
    assert.equal(riskSubject(operation), null);
    assert.equal(attemptMinor(operation), 0n);
  }
}

// --- The whole loop end to end: adding attempts until the limit blocks --------------

function accumulatesUntilTheCeilingThenClearsAsTheWindowSlides(): void {
  let config = gateConfig(1_000n); // limit of 1000 minor units = 10.00
  let windowMs = config.velocityWindowMs;
  let operation = spend({
    buyerId: 'usr_buyer',
    sku: 'wrld_pass',
    price: credit('4.00'),
  });

  // Two prior 4.00 attempts inside the window, each under its own idempotency key so both count
  // (a repeated key would be treated as a retry and ignored).
  let attempts: Attempt[] = [
    {
      idempotencyKey: 'a1',
      amount: credit('4.00'),
      at: 100,
      outcome: 'rejected',
    },
    {
      idempotencyKey: 'a2',
      amount: credit('4.00'),
      at: 200,
      outcome: 'rejected',
    },
  ];

  // With nothing counted yet, a 4.00 spend is allowed.
  let none = windowedVelocity('usr_buyer', [], 300, windowMs);
  assert.deepEqual(assessRisk(none, operation, config), { allow: true });

  // With one attempt counted (4.00), a 4.00 spend projects to 8.00, still within the 10.00 limit.
  let one = windowedVelocity('usr_buyer', attempts.slice(0, 1), 300, windowMs);
  assert.deepEqual(assessRisk(one, operation, config), { allow: true });

  // With both counted (8.00), a 4.00 spend projects to 12.00, past the 10.00 limit, so it denies.
  let both = windowedVelocity('usr_buyer', attempts, 300, windowMs);
  assert.deepEqual(assessRisk(both, operation, config), {
    allow: false,
    reason: 'RISK_DENIED',
  });

  // Once both attempts have aged out of the window, the subject is allowed again. The limit does
  // NOT stick forever — the bug this fixes was a running total that never reset.
  let later = windowedVelocity(
    'usr_buyer',
    attempts,
    200 + windowMs + 1,
    windowMs,
  );
  assert.deepEqual(assessRisk(later, operation, config), { allow: true });
}

// --- The wired store: the memory trust store applies the window on read -------------
// The helper tests above are pure; this proves the store actually calls `windowedVelocity` with
// its clock, so a bumped attempt ages out of `read` once the clock passes the window. This is the
// regression lock for the original bug, where the store kept a running total that never reset.
async function theStoreAgesAttemptsOutOfReadOnceTheWindowPasses(): Promise<void> {
  let nowMs = 0;
  let store = memoryStore({
    clock: { now: () => nowMs },
    velocityWindowMs: 3_600_000,
  });

  await store.trust.bump('usr_buyer', {
    idempotencyKey: 'one',
    amount: credit('5.00'),
    at: 0,
    outcome: 'rejected',
  });

  // While the attempt is fresh it counts toward the total.
  assert.deepEqual((await store.trust.read('usr_buyer')).spent, credit('5.00'));

  // Advance the clock past the window: the same attempt has now aged out, so the total is zero.
  nowMs = 3_600_000 + 1;
  assert.deepEqual((await store.trust.read('usr_buyer')).spent, credit('0.00'));

  await store.close();
}

describe('Trust', () => {
  test('allows a spend when the projected window total is under the ceiling', () =>
    allowsWhenProjectedUnderCeiling());
  test('denies with the returned RISK_DENIED when the projection exceeds the ceiling', () =>
    deniesWithRiskDeniedWhenProjectedOverCeiling());
  test('allows at exactly the ceiling, since denial is strictly over', () =>
    allowsAtExactlyTheCeiling());
  test('allows an operation that moves no money regardless of the spending total', () =>
    allowsAnOperationOutsideTheRiskSurface());

  test('reads an empty window for a fresh subject', () =>
    readsAnEmptyWindowForAFreshSubject());
  test('sums attempts inside the rolling window', () =>
    sumsAttemptsInsideTheWindow());
  test('drops attempts older than the window (cutoff is exclusive)', () =>
    dropsAttemptsOlderThanTheWindow());
  test('ages attempts out one at a time as the window slides', () =>
    agesAttemptsOutOneAtATimeAsTheWindowSlides());

  test('builds a rejected attempt keyed on the operation key so declines accumulate', () =>
    buildsARejectedAttemptKeyedOnTheOperationKey());
  test('builds a committed attempt from a settled operation', () =>
    buildsACommittedAttemptFromASettledOperation());
  test('records no attempt for a duplicate, so a retry never double-counts', () =>
    recordsNoAttemptForADuplicate());
  test('records no attempt for an operation that moves no money', () =>
    recordsNoAttemptOutsideTheRiskSurface());

  test('keys funds-moving operations on their subject and sizes the attempt', () =>
    keysFundsMovingOperationsOnTheirSubject());
  test('keys no subject and a zero attempt for non-funds operations', () =>
    keysNoSubjectForNonFundsOperations());

  test('accumulates until the ceiling blocks, then clears as the window slides', () =>
    accumulatesUntilTheCeilingThenClearsAsTheWindowSlides());

  test('the memory store ages attempts out of read once the window passes', () =>
    theStoreAgesAttemptsOutOfReadOnceTheWindowPasses());
});
