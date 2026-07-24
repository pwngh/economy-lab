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

import { transportFault } from '#src/adapters/transport-fault.ts';
import { encodeEvent } from '#src/adapters/event-wire.ts';

import type { Dispatcher, EconomyEvent, CallOptions } from '#src/ports.ts';

// --- The @aws-sdk/client-sqs surface, typed structurally --------------------------

/**
 * Structural shape of the command object `SqsClient.send` takes: an object carrying its input
 * fields, standing in for the SDK's `SendMessageCommand` so the file compiles without the
 * optional `@aws-sdk/client-sqs` dependency installed.
 */
export interface SqsCommand {
  readonly input: Record<string, unknown>;
}

/**
 * Structural shape of the SQS client the adapter calls: just the `send` method, so a real
 * `SQSClient` from `@aws-sdk/client-sqs` satisfies it and a test can pass a plain object. The
 * adapter never imports the SDK; the caller creates and owns the client.
 */
export interface SqsClient {
  send(
    command: SqsCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<Record<string, unknown>>;
}

// Stands in for the SDK's `new SendMessageCommand(input)`; the field names are SQS's own.
function sendMessageCommand(input: {
  QueueUrl: string;
  MessageBody: string;
  MessageDeduplicationId?: string;
  MessageGroupId?: string;
}): SqsCommand {
  return { input };
}

// --- Outbound dispatcher ----------------------------------------------------------

export interface SqsDispatcherOptions {
  /**
   * The full queue URL. A `.fifo` suffix switches on the FIFO-only parameters — dedup by event
   * id, group by subject — which a standard queue rejects.
   */
  queueUrl: string;

  /** The SQS client the caller created and owns (a real one, or a test stand-in). */
  client: SqsClient;
}

/**
 * Builds the {@link Dispatcher} that publishes events to SQS as JSON messages, the body encoded
 * by the shared `encodeEvent` (event-wire.ts). Delivery is at-least-once either way; what varies
 * is who dedupes. On a FIFO queue (URL ends in `.fifo`) the event id becomes the
 * `MessageDeduplicationId`, so a resend inside SQS's dedup window is dropped at the queue, and
 * the event subject becomes the `MessageGroupId`, so one subject's events deliver in order. On a
 * standard queue those parameters are omitted (SQS rejects them there) and the receiver dedupes
 * by the event id carried in the body.
 *
 * On failure it throws a retryable `PROVIDER.FAILURE` so the caller's backoff wrapper retries.
 *
 * @example
 * import { SQSClient } from '@aws-sdk/client-sqs';
 * const dispatch = sqsDispatcher({
 *   queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/economy-events.fifo',
 *   client: new SQSClient({ region: 'us-east-1' }),
 * });
 * await dispatch(event); // resolves once SQS accepts the message
 *
 * @see {@link https://economy-lab-docs.pages.dev/economy/ports/messaging/ Messaging} for how dispatchers deliver events.
 */
export function sqsDispatcher(config: SqsDispatcherOptions): Dispatcher {
  const client = config.client;
  // The FIFO-only params (MessageGroupId, MessageDeduplicationId) draw InvalidParameterValue on a
  // standard queue, so attach them only when the URL suffix says FIFO.
  const fifo = config.queueUrl.endsWith('.fifo');

  return async (event: EconomyEvent, options?: CallOptions): Promise<void> => {
    try {
      await client.send(
        sendMessageCommand({
          QueueUrl: config.queueUrl,
          MessageBody: encodeEvent(event),
          // Dedup by event id so a resend is a no-op; group by subject so a subject's events
          // deliver in order.
          ...(fifo && {
            MessageDeduplicationId: event.id,
            MessageGroupId: event.subject,
          }),
        }),
        { abortSignal: options?.signal },
      );
    } catch (error) {
      throw transportFault('SQS SendMessage failed.', error);
    }
  };
}

// --- Local helpers ----------------------------------------------------------------
