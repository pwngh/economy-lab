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
