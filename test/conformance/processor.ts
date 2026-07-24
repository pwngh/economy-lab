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

import { decodeAmount } from '#src/money.ts';

import type { PayoutProviderStatus, Processor } from '#src/ports.ts';

/**
 * What a Processor conformance run needs from the host: factories that produce a processor
 * arranged to exhibit each outcome. Only `accepted` is required; each optional member unlocks its
 * matching test, so a provider whose fake cannot stage a failure mode simply omits it. `status`
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
 * It proves: an accepted submit resolves to a non-empty `providerRef`, the handle every later
 * settle and status poll keys on; an indeterminate submit throws a retryable coded fault, so the
 * worker resubmits under the same payout key instead of treating an unknown outcome as terminal;
 * a terminal rejection throws a non-retryable coded fault, so the saga stops retrying and
 * unwinds; and `payoutStatus` reports each of the five canonical states — SETTLED, RETURNED,
 * FAILED, PENDING, UNKNOWN — faithfully. Tests for the optional harness members register only
 * when the {@link ProcessorHarness} supplies them, so the required surface is a single accepted
 * path.
 */
export function runProcessorConformance(
  name: string,
  harness: ProcessorHarness,
): void {
  describe(`Processor Contract: ${name}`, () => {
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
