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

import '#test/support/dist-guard.ts';

import { sqs, sqsDispatcher } from '@pwngh/economy-sqs';
import { runDispatcherConformance } from '#test/conformance/dispatcher.ts';

import type { SqsClient, SqsCommand } from '@pwngh/economy-sqs';
import type { EconomyError } from '#src/errors.ts';
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
    const captured = captureClient();

    const dispatch = sqsDispatcher({ queueUrl: 'q', client: captured });
    await dispatch(sampleEvent());

    const input = captured.inputs[0];
    // AWS rejects MessageGroupId/MessageDeduplicationId on a standard queue (InvalidParameterValue),
    // so the dispatcher omits both when the queue URL has no `.fifo` suffix.
    assert.equal('MessageGroupId' in input, false);
    assert.equal('MessageDeduplicationId' in input, false);
  });

  test('a .fifo queue includes MessageGroupId and MessageDeduplicationId', async () => {
    const captured = captureClient();

    const dispatch = sqsDispatcher({ queueUrl: 'q.fifo', client: captured });
    await dispatch(sampleEvent());

    const input = captured.inputs[0];
    assert.equal(input.MessageGroupId, 'usr_conf_1');
    assert.equal(input.MessageDeduplicationId, 'evt_sqs_1');
  });
});

function captureClient(): SqsClient & { inputs: Record<string, unknown>[] } {
  const inputs: Record<string, unknown>[] = [];
  return {
    inputs,
    send: async (command: SqsCommand) => {
      inputs.push(command.input);
      return {};
    },
  };
}

function sqsHarness(): DispatcherHarness {
  const bodies: string[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  let fail: Error | null = null;
  const client: SqsClient = {
    send: async (command: SqsCommand, options) => {
      signals.push(options?.abortSignal);
      if (fail) {
        const error = fail;
        fail = null;
        throw error;
      }
      const input = command.input;
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

// The client-opening form is the default path: one import, one call, no `new SQSClient(...)` at
// the call site. It reaches a queue that does not exist, so the proof is that the AWS SDK loaded,
// built a real command, and the failure came back as the adapter's own transport fault.
describe('sqs(options): the client is opened inside', () => {
  test('opens the SDK client and surfaces a send failure as PROVIDER.FAILURE', async () => {
    const dispatch = await sqs({
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/000000000000/economy-none',
      region: 'us-east-1',
    });
    await assert.rejects(dispatch(sampleEvent()), (error: unknown) => {
      assert.equal((error as EconomyError).code, 'PROVIDER.FAILURE');
      return true;
    });
    await dispatch.close();
  });

  test('closes the client it opened, and never one it was handed', async () => {
    const opened = await sqs({
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/000000000000/economy-none',
      region: 'us-east-1',
    });
    // Ownership follows creation: the URL form opened the client, so it releases it.
    assert.equal(typeof opened.close, 'function');
    await opened.close();

    const handed = sqsDispatcher({
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/000000000000/economy-none',
      client: { send: async () => ({}) },
    });
    assert.equal(handed.close, undefined);
  });
});
