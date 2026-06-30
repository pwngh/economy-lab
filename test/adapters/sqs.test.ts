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

import { sqsDispatcher } from '#src/adapters/sqs.ts';
import { runDispatcherConformance } from '#test/conformance/dispatcher.ts';

import type { SqsClient, SqsCommand } from '#src/adapters/sqs.ts';
import type { EconomyEvent } from '#src/ports.ts';
import type { DispatcherHarness } from '#test/conformance/dispatcher.ts';

function sampleEvent(): EconomyEvent {
  return {
    id: 'evt_sqs_1',
    type: 'economy.credits.topped_up',
    version: 1,
    occurredAt: 0,
    subject: 'usr_conf_1',
    // Amount is a string: events carry money as strings so the JSON body never has to
    // serialize a bigint (JSON.stringify throws on one).
    data: { amount: '5.00' },
    audience: 'internal',
  };
}

describe('sqsDispatcher: FIFO Param Detection', () => {
  test('a standard (non-.fifo) queue omits the FIFO-only params', async () => {
    let captured = captureClient();

    let dispatch = sqsDispatcher({ queueUrl: 'q', client: captured });
    await dispatch(sampleEvent());

    let input = captured.inputs[0];
    // AWS rejects MessageGroupId/MessageDeduplicationId on a standard queue (InvalidParameterValue),
    // so the dispatcher omits both when the queue URL has no `.fifo` suffix. Default deployment is
    // a standard queue.
    assert.equal('MessageGroupId' in input, false);
    assert.equal('MessageDeduplicationId' in input, false);
  });

  test('a .fifo queue includes MessageGroupId and MessageDeduplicationId', async () => {
    let captured = captureClient();

    let dispatch = sqsDispatcher({ queueUrl: 'q.fifo', client: captured });
    await dispatch(sampleEvent());

    let input = captured.inputs[0];
    // On a FIFO queue the subject sets MessageGroupId (the key SQS orders within) and the event
    // id sets MessageDeduplicationId, so resending the same event delivers it once.
    assert.equal(input.MessageGroupId, 'usr_conf_1');
    assert.equal(input.MessageDeduplicationId, 'evt_sqs_1');
  });
});

// Records the raw SendMessage input of each call, so a test can assert which request
// parameters the dispatcher attached.
function captureClient(): SqsClient & { inputs: Record<string, unknown>[] } {
  let inputs: Record<string, unknown>[] = [];
  return {
    inputs,
    send: async (command: SqsCommand) => {
      inputs.push(command.input);
      return {};
    },
  };
}

// Builds a harness that runs the shared Dispatcher contract against the SQS adapter. The fake
// client records message bodies and abort signals, and it can be told to fail the next send.
function sqsHarness(): DispatcherHarness {
  let bodies: string[] = [];
  let signals: Array<AbortSignal | undefined> = [];
  let fail: Error | null = null;
  let client: SqsClient = {
    send: async (command: SqsCommand, options) => {
      signals.push(options?.abortSignal);
      if (fail) {
        let error = fail;
        fail = null;
        throw error;
      }
      let input = command.input;
      if ('MessageBody' in input) {
        bodies.push(input.MessageBody as string);
      }
      return {};
    },
  };
  return {
    dispatcher: sqsDispatcher({ queueUrl: 'q', client }),
    bodies,
    signals,
    failNext: (error) => {
      fail = error;
    },
  };
}

runDispatcherConformance('sqs', sqsHarness);
