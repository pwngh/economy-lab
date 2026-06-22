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
import type { SqsClient, SqsCommand } from '#src/adapters/sqs.ts';
import type { EconomyEvent } from '#src/ports.ts';

function sampleEvent(): EconomyEvent {
  return {
    id: 'evt_sqs_1',
    type: 'economy.credits.topped_up',
    version: 1,
    occurredAt: 0,
    subject: 'usr_conf_1',
    // The amount is already a string, the way an event carries money: amounts are
    // converted to strings before they reach an event, so the JSON body never has to
    // serialize a bigint (JSON.stringify throws on one).
    data: { amount: '5.00' },
    audience: 'internal',
  };
}

describe('Dispatcher Conformance: sqs', () => {
  test('dispatches the event envelope as its JSON message body', async () => {
    let stub = stubClient();

    let dispatch = sqsDispatcher({ queueUrl: 'q', client: stub });
    await dispatch(sampleEvent());

    // Exactly one message was sent, and its body is the event envelope verbatim — parsing
    // it back yields the original event, the same round-trip a receiver performs.
    assert.equal(stub.sent.length, 1);
    assert.deepEqual(JSON.parse(stub.sent[0]), sampleEvent());
  });
});

describe('sqsDispatcher: FIFO Param Detection', () => {
  test('a standard (non-.fifo) queue omits the FIFO-only params', async () => {
    let captured = captureClient();

    let dispatch = sqsDispatcher({ queueUrl: 'q', client: captured });
    await dispatch(sampleEvent());

    let input = captured.inputs[0];
    // AWS rejects MessageGroupId/MessageDeduplicationId on a standard (non-ordered) queue
    // and returns an InvalidParameterValue error, so the dispatcher must leave both off
    // when the queue URL has no `.fifo` suffix. The default deployment uses a standard queue.
    assert.equal('MessageGroupId' in input, false);
    assert.equal('MessageDeduplicationId' in input, false);
  });

  test('a .fifo queue includes MessageGroupId and MessageDeduplicationId', async () => {
    let captured = captureClient();

    let dispatch = sqsDispatcher({ queueUrl: 'q.fifo', client: captured });
    await dispatch(sampleEvent());

    let input = captured.inputs[0];
    // On a FIFO (first-in-first-out, ordered) queue the subject sets MessageGroupId, the
    // key SQS orders within, and the event id sets MessageDeduplicationId. So if the same
    // event is sent twice, SQS recognizes the repeated id and delivers it only once.
    assert.equal(input.MessageGroupId, 'usr_conf_1');
    assert.equal(input.MessageDeduplicationId, 'evt_sqs_1');
  });
});

// A stand-in that records the raw SendMessage input of each call, so a test can assert
// exactly which request parameters the dispatcher attached.
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

// A small in-memory stand-in for an AWS SQS client that records every message body the
// dispatcher sends, so a test can count dispatches and inspect the JSON envelope. The
// adapter only needs the `SqsClient` shape (a `send` method), so this fake fits without
// pulling in the real `@aws-sdk/client-sqs` package, which isn't installed.
function stubClient(): SqsClient & { sent: string[] } {
  let sent: string[] = [];
  return {
    sent,
    send: async (command: SqsCommand) => {
      let input = command.input;
      if ('MessageBody' in input) {
        sent.push(input.MessageBody as string);
      }
      return {};
    },
  };
}
