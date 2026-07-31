/// <reference types="node" />
/**
 * @pwngh/economy-sqs
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

import { runDispatcherConformance } from '@pwngh/economy-lab/testing';

import { sqs, sqsDispatcher } from '../src/index.js';

import type { DispatcherHarness } from '@pwngh/economy-lab/testing';
import type { EconomyEvent } from '@pwngh/economy-lab/ports';
import type { SqsCommand } from '../src/index.js';

function sampleEvent(): EconomyEvent {
  return {
    id: 'evt_pkg_1',
    type: 'economy.credits.topped_up',
    version: 1,
    occurredAt: 0,
    subject: 'usr_ada',
    data: { amount: '120.00' },
    audience: 'internal',
  };
}

// The whole Dispatcher contract, against a stand-in client, so it runs with no AWS reachable.
function harness(queueUrl: string): DispatcherHarness {
  const bodies: string[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  let fail: unknown = null;
  return {
    dispatcher: sqsDispatcher({
      queueUrl,
      client: {
        send: async (command, options) => {
          signals.push(options?.abortSignal);
          if (fail !== null) {
            const error = fail;
            fail = null;
            throw error;
          }
          bodies.push(command.input.MessageBody as string);
          return {};
        },
      },
    }),
    bodies,
    signals,
    failNext: (error: unknown) => {
      fail = error;
    },
  };
}

runDispatcherConformance('economy-sqs', () => harness('q'));

// The FIFO parameters are rejected outright on a standard queue, so the URL suffix — not a flag —
// decides whether they are attached.
describe('the queue URL decides the FIFO parameters', () => {
  for (const [label, queueUrl, expected] of [
    ['standard', 'https://sqs.us-east-1.amazonaws.com/1/economy', false],
    ['fifo', 'https://sqs.us-east-1.amazonaws.com/1/economy.fifo', true],
  ] as const) {
    test(`${label}: MessageGroupId is ${expected ? 'set' : 'absent'}`, async () => {
      const inputs: SqsCommand['input'][] = [];
      const dispatch = sqsDispatcher({
        queueUrl,
        client: {
          send: async (command) => {
            inputs.push(command.input);
            return {};
          },
        },
      });
      await dispatch(sampleEvent());
      assert.equal('MessageGroupId' in inputs[0]!, expected);
      assert.equal('MessageDeduplicationId' in inputs[0]!, expected);
    });
  }
});

// The client-opening form is the default path. The queue does not exist, so the proof is that
// the AWS SDK loaded, built a real command, and the failure came back as the adapter's fault.
describe('the client is opened inside', () => {
  test('opens the SDK client and maps a send failure to PROVIDER.FAILURE', async () => {
    const dispatch = await sqs({
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/000000000000/economy-none',
      region: 'us-east-1',
    });
    await assert.rejects(dispatch(sampleEvent()), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'PROVIDER.FAILURE');
      assert.equal((error as { retryable?: boolean }).retryable, true);
      return true;
    });
  });
});
