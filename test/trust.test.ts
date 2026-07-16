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

function gateConfig(limitMinor: bigint, windowMs = 3_600_000) {
  return {
    ...testConfig(),
    velocityLimitMinor: limitMinor,
    velocityWindowMs: windowMs,
  };
}

// The shape the risk check receives after the store brings the record up to date.
function velocityAt(windowStart: number, spentMinor: bigint): Velocity {
  return {
    subject: 'usr_buyer',
    windowStart,
    spent: toAmount('CREDIT', spentMinor),
    attempts: 1,
  };
}

// Denied attempts still count toward the limit, so denial-path tests use this outcome.
const REJECTED: Outcome = { status: 'rejected', reason: 'RISK_DENIED' };

// The contents do not matter: the attempt builder reads only the outcome status and the operation key.
function withTransaction(status: 'committed' | 'duplicate'): Outcome {
  const transaction: Transaction = {
    id: 'txn_test',
    postedAt: 0,
    legs: [],
    links: [],
    meta: {},
  };
  return { status, transaction };
}

describe('Trust', () => {
  // --- assessRisk: deciding whether to allow an operation ----------------------------

  test('allows a spend when the projected window total is under the ceiling', () => {
    const velocity = velocityAt(0, 600n); // 600 minor units = 6.00 already spent this window
    const operation = spend({
      buyerId: 'usr_buyer',
      sku: 'wrld_pass',
      price: credit('3.00'),
    });

    const decision = assessRisk(velocity, operation, gateConfig(1_000n));

    assert.deepEqual(decision, { allow: true });
  });

  test('denies with the returned RISK_DENIED when the projection exceeds the ceiling', () => {
    const velocity = velocityAt(0, 800n); // 800 minor units = 8.00 already spent this window
    const operation = spend({
      buyerId: 'usr_buyer',
      sku: 'wrld_pass',
      price: credit('3.00'),
    });

    const decision = assessRisk(velocity, operation, gateConfig(1_000n));

    assert.deepEqual(decision, { allow: false, reason: 'RISK_DENIED' });
  });

  test('allows at exactly the ceiling, since denial is strictly over', () => {
    const velocity = velocityAt(0, 700n);
    const operation = spend({
      buyerId: 'usr_buyer',
      sku: 'wrld_pass',
      price: credit('3.00'),
    });

    // 7.00 + 3.00 lands exactly on the 10.00 limit.
    const decision = assessRisk(velocity, operation, gateConfig(1_000n));

    assert.deepEqual(decision, { allow: true });
  });

  test('allows an operation that moves no money regardless of the spending total', () => {
    const velocity = velocityAt(0, 1_000_000n); // a spend total far past any limit
    const operation: Operation = {
      // cancelSubscription moves no money, so the risk check never applies to it.
      kind: 'cancelSubscription',
      idempotencyKey: 'idem_cancel',
      actor: { kind: 'system', service: 'test' },
      subscriptionId: 'sub_1',
    };

    const decision = assessRisk(velocity, operation, gateConfig(1n));

    assert.deepEqual(decision, { allow: true });
  });

  // --- The spending window: windowedVelocity (a sliding window) -----------------------
  // The cutoff is exclusive: an attempt counts while `at > now - windowMs`.

  test('reads an empty window for a fresh subject', () => {
    const velocity = windowedVelocity('usr_new', [], 5_000, 3_600_000);

    assert.deepEqual(velocity, emptyVelocity('usr_new'));
  });

  test('sums attempts inside the rolling window', () => {
    const attempts: Attempt[] = [
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

    // windowStart comes back as the earliest `at` still in the window.
    const velocity = windowedVelocity('usr_buyer', attempts, 2_500, 3_600_000);

    assert.deepEqual(velocity, {
      subject: 'usr_buyer',
      windowStart: 1_000,
      spent: credit('8.00'),
      attempts: 2,
    });
  });

  test('drops attempts older than the window (cutoff is exclusive)', () => {
    const attempts: Attempt[] = [
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

    // The first attempt's `at` equals the cutoff exactly, and the cutoff is exclusive, so it ages out.
    const now = 1_000 + 3_600_000;
    const velocity = windowedVelocity('usr_buyer', attempts, now, 3_600_000);

    assert.deepEqual(velocity, {
      subject: 'usr_buyer',
      windowStart: now,
      spent: credit('3.00'),
      attempts: 1,
    });
  });

  test('ages attempts out one at a time as the window slides', () => {
    const attempts: Attempt[] = [
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

    const now = 1_000 + 3_600_001;
    const velocity = windowedVelocity('usr_buyer', attempts, now, 3_600_000);

    assert.deepEqual(velocity, {
      subject: 'usr_buyer',
      windowStart: 1_800_000,
      spent: credit('4.00'),
      attempts: 1,
    });
  });

  // --- riskAttempt: building the record added to the spending total after an operation runs

  test('builds a rejected attempt keyed on the operation key so declines accumulate', () => {
    const operation = spend({
      buyerId: 'usr_buyer',
      sku: 'wrld_pass',
      price: credit('4.00'),
    });

    // Many declines in a row is itself a fraud signal, so a denied attempt still counts.
    const attempt = riskAttempt(operation, REJECTED, 9_000);

    assert.deepEqual(attempt, {
      idempotencyKey: operation.idempotencyKey,
      amount: credit('4.00'),
      at: 9_000,
      outcome: 'rejected',
    });
  });

  test('builds a committed attempt from a settled operation', () => {
    const operation = topUp({ userId: 'usr_buyer', amount: credit('5.00') });

    const attempt = riskAttempt(
      operation,
      withTransaction('committed'),
      12_000,
    );

    assert.deepEqual(attempt, {
      idempotencyKey: operation.idempotencyKey,
      amount: credit('5.00'),
      at: 12_000,
      outcome: 'committed',
    });
  });

  test('records no attempt for a duplicate, so a retry never double-counts', () => {
    const operation = spend({
      buyerId: 'usr_buyer',
      sku: 'wrld_pass',
      price: credit('4.00'),
    });

    const attempt = riskAttempt(operation, withTransaction('duplicate'), 9_000);

    assert.equal(attempt, null);
  });

  test('records no attempt for an operation that moves no money', () => {
    const operation: Operation = {
      kind: 'cancelSubscription',
      idempotencyKey: 'idem_cancel',
      actor: { kind: 'system', service: 'test' },
      subscriptionId: 'sub_1',
    };

    const attempt = riskAttempt(operation, withTransaction('committed'), 9_000);

    assert.equal(attempt, null);
  });

  // --- Picking the subject and size of an attempt: riskSubject + attemptMinor --------

  test('keys funds-moving operations on their subject and sizes the attempt', () => {
    const cases: ReadonlyArray<{
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

    for (const { operation, subject, minor } of cases) {
      assert.equal(riskSubject(operation), subject);
      assert.equal(attemptMinor(operation), minor);
    }
  });

  test('keys no subject and a zero attempt for non-funds operations', () => {
    const cases: ReadonlyArray<Operation> = [
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

    for (const operation of cases) {
      assert.equal(riskSubject(operation), null);
      assert.equal(attemptMinor(operation), 0n);
    }
  });

  // --- The whole loop end to end: adding attempts until the limit blocks --------------

  test('accumulates until the ceiling blocks, then clears as the window slides', () => {
    const config = gateConfig(1_000n); // limit of 1000 minor units = 10.00
    const windowMs = config.velocityWindowMs;
    const operation = spend({
      buyerId: 'usr_buyer',
      sku: 'wrld_pass',
      price: credit('4.00'),
    });

    // Distinct idempotency keys so both attempts count (a repeated key reads as a retry).
    const attempts: Attempt[] = [
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

    const none = windowedVelocity('usr_buyer', [], 300, windowMs);
    assert.deepEqual(assessRisk(none, operation, config), { allow: true });

    const one = windowedVelocity(
      'usr_buyer',
      attempts.slice(0, 1),
      300,
      windowMs,
    );
    assert.deepEqual(assessRisk(one, operation, config), { allow: true });

    const both = windowedVelocity('usr_buyer', attempts, 300, windowMs);
    assert.deepEqual(assessRisk(both, operation, config), {
      allow: false,
      reason: 'RISK_DENIED',
    });

    const later = windowedVelocity(
      'usr_buyer',
      attempts,
      200 + windowMs + 1,
      windowMs,
    );
    assert.deepEqual(assessRisk(later, operation, config), { allow: true });
  });

  // --- The wired store: the memory trust store applies the window on read -------------
  // Regression lock: the original bug kept a running total that never reset.
  test('the memory store ages attempts out of read once the window passes', async () => {
    let nowMs = 0;
    const store = memoryStore({
      clock: { now: () => nowMs },
      velocityWindowMs: 3_600_000,
    });

    await store.trust.bump('usr_buyer', {
      idempotencyKey: 'one',
      amount: credit('5.00'),
      at: 0,
      outcome: 'rejected',
    });

    assert.deepEqual(
      (await store.trust.read('usr_buyer')).spent,
      credit('5.00'),
    );

    nowMs = 3_600_000 + 1;
    assert.deepEqual(
      (await store.trust.read('usr_buyer')).spent,
      credit('0.00'),
    );

    await store.close();
  });
});
