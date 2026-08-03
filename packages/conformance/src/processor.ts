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

import { describe, test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';

import { countedCases } from './cases.js';
import { decodeAmount } from '@pwngh/economy-lab';

import type { PayoutProviderStatus, Processor } from '@pwngh/economy-lab/ports';

/**
 * A Processor conformance run needs these factories from the host. Each factory produces a
 * processor arranged to exhibit one outcome. Only `accepted` is required. Each optional member
 * unlocks its matching test, so a provider whose fake cannot stage a failure mode simply omits it. `status`
 * returns a processor plus the `providerRef` to query, staged so `payoutStatus` for that ref
 * reports the given canonical state.
 */
export interface ProcessorHarness {
  accepted(): Processor;
  indeterminate?(): Processor;
  rejected?(): Processor;
  status?(state: PayoutProviderStatus['state']): {
    processor: Processor;
    providerRef: string;
  };
}

const PAYOUT_STATES: ReadonlyArray<PayoutProviderStatus['state']> = [
  'SETTLED',
  'RETURNED',
  'FAILED',
  'PENDING',
  'UNKNOWN',
];

function payout() {
  return {
    key: 'pay_contract_1',
    userId: 'usr_contract_1',
    amount: decodeAmount('2.00', 'USD'),
  };
}

/**
 * Registers the shared {@link Processor} contract the payout saga depends on, for `node --test`.
 * It proves four things. An accepted submit resolves to a non-empty `providerRef`, the handle
 * every later settle and status poll keys on. An indeterminate submit throws a retryable coded
 * fault, so the worker resubmits under the same payout key instead of treating an unknown outcome
 * as terminal. A terminal rejection throws a non-retryable coded fault, so the saga stops retrying
 * and unwinds. `payoutStatus` reports each of the five canonical states — SETTLED, RETURNED,
 * FAILED, PENDING, UNKNOWN — faithfully. Tests for the optional harness members register only
 * when the {@link ProcessorHarness} supplies them, so the required surface is a single accepted
 * path.
 */
export function runProcessorConformance(
  name: string,
  harness: ProcessorHarness,
): void {
  describe(`Processor Contract: ${name}`, () => {
    // Each optional half of the harness registers a case, so what this suite adds to a driver's
    // total depends on what the caller supplied. Two are unconditional: the accepted path and the
    // count itself.
    const test = countedCases(
      'runProcessorConformance',
      2 +
        (harness.indeterminate === undefined ? 0 : 1) +
        (harness.rejected === undefined ? 0 : 1) +
        (harness.status === undefined ? 0 : 1),
      (name, body) => nodeTest(name, body),
    );

    test('an accepted submit resolves to a non-empty providerRef', async () => {
      const result = await harness.accepted().submitPayout(payout());

      assert.equal(typeof result.providerRef, 'string');
      assert.ok(result.providerRef.length > 0);
    });

    if (harness.indeterminate !== undefined) {
      test('an indeterminate submit throws a retryable coded fault', async () => {
        await assert.rejects(
          harness.indeterminate!().submitPayout(payout()),
          (error: unknown) => {
            const fault = error as { code?: unknown; retryable?: unknown };
            assert.equal(typeof fault.code, 'string');
            assert.equal(fault.retryable, true);
            return true;
          },
        );
      });
    }

    if (harness.rejected !== undefined) {
      test('a terminal rejection throws a non-retryable coded fault', async () => {
        await assert.rejects(
          harness.rejected!().submitPayout(payout()),
          (error: unknown) => {
            const fault = error as { code?: unknown; retryable?: unknown };
            assert.equal(typeof fault.code, 'string');
            assert.notEqual(fault.retryable, true);
            return true;
          },
        );
      });
    }

    if (harness.status !== undefined) {
      test('payoutStatus reports every canonical state faithfully', async () => {
        for (const state of PAYOUT_STATES) {
          const { processor, providerRef } = harness.status!(state);

          const status = await processor.payoutStatus!({ providerRef });

          assert.equal(status.state, state, state);
        }
      });
    }
  });
}
